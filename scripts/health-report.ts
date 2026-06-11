// scripts/health-report.ts
// Pipeline health report with breach thresholds. Run standalone
// (`bun run health`) or via the daily health cron. Read-only.

import { query, endPool } from "@/lib/db";
import { AGGREGATOR_URL_SQL_REGEX } from "@/lib/aggregators";

export interface HealthMetrics {
  articlesIngested24h: number;
  cronErrors24h: number;
  rewrite: {
    attempts: number;
    llmErrors: number;
    accepted: number;
    llmErrorShare: number | null;
    acceptShare: number | null;
  };
  prefetch: {
    attempted: number;
    success: number;
    successShare: number | null;
  };
  discovery: {
    searches: number;
    successes: number;
    successShare: number | null;
  };
  scoresStaleMinutes: number | null;
  unrewrittenLeads7d: number;
  hiddenAggregatorLeadShare72h: number | null;
  singletonShare: number | null;
}

export interface HealthReport {
  ok: boolean;
  windowHours: number;
  breaches: string[];
  metrics: HealthMetrics;
}

// Thresholds are regression guards calibrated to the 2026-06 baseline; raise
// them as the pipeline improves (see tmp/improvement-plan-2026-06.md).
const THRESHOLDS = {
  rewriteLlmErrorShareMax: 0.1, // min 20 attempts
  prefetchSuccessShareMin: 0.3, // among attempted, min 50
  discoverySuccessShareMin: 0.5, // min 10 searches
  scoresStaleMinutesMax: 600,
};

function share(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export async function run(
  opts: { windowHours?: number; closePool?: boolean } = {},
): Promise<HealthReport> {
  const windowHours = opts.windowHours ?? 48;

  const { rows: ingestRows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM articles WHERE fetched_at > now() - interval '24 hours'`,
  );
  const articlesIngested24h = ingestRows[0].n;

  const { rows: cronRows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pipeline_runs
     WHERE started_at > now() - interval '24 hours' AND status = 'error'`,
  );
  const cronErrors24h = cronRows[0].n;

  const { rows: rwRows } = await query<{
    attempts: number;
    llm_errors: number;
    accepted: number;
  }>(
    `SELECT count(*)::int AS attempts,
            count(*) FILTER (WHERE validation_failures->>'reason' = 'llm_error')::int AS llm_errors,
            count(*) FILTER (WHERE accepted)::int AS accepted
     FROM rewrite_attempts
     WHERE created_at > now() - make_interval(hours => $1)`,
    [windowHours],
  );
  const rw = rwRows[0];

  const { rows: pfRows } = await query<{ attempted: number; success: number }>(
    `SELECT count(*) FILTER (WHERE content_status IS NOT NULL)::int AS attempted,
            count(*) FILTER (WHERE content_status = 'success')::int AS success
     FROM articles
     WHERE fetched_at > now() - make_interval(hours => $1)`,
    [windowHours],
  );
  const pf = pfRows[0];

  const { rows: dsRows } = await query<{ searches: number; successes: number }>(
    `SELECT count(*)::int AS searches,
            count(*) FILTER (WHERE status = 'success')::int AS successes
     FROM discovery_searches
     WHERE created_at > now() - make_interval(hours => $1)`,
    [windowHours],
  );
  const ds = dsRows[0];

  const { rows: staleRows } = await query<{ minutes: number | null }>(
    `SELECT round(extract(epoch FROM (now() - max(updated_at))) / 60)::int AS minutes
     FROM cluster_scores`,
  );
  const scoresStaleMinutes = staleRows[0].minutes;

  const { rows: backlogRows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM cluster_scores cs JOIN articles a ON a.id = cs.lead_article_id
     WHERE a.rewritten_title IS NULL
       AND a.fetched_at > now() - interval '7 days'`,
  );

  const { rows: hiddenRows } = await query<{ total: number; hidden: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE a.canonical_url ~* '${AGGREGATOR_URL_SQL_REGEX}'
            )::int AS hidden
     FROM cluster_scores cs JOIN articles a ON a.id = cs.lead_article_id
     WHERE a.published_at > now() - interval '72 hours'`,
  );

  const { rows: singletonRows } = await query<{
    total: number;
    singles: number;
  }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE size = 1)::int AS singles
     FROM cluster_scores`,
  );

  const metrics: HealthMetrics = {
    articlesIngested24h,
    cronErrors24h,
    rewrite: {
      attempts: rw.attempts,
      llmErrors: rw.llm_errors,
      accepted: rw.accepted,
      llmErrorShare: share(rw.llm_errors, rw.attempts),
      acceptShare: share(rw.accepted, rw.attempts),
    },
    prefetch: {
      attempted: pf.attempted,
      success: pf.success,
      successShare: share(pf.success, pf.attempted),
    },
    discovery: {
      searches: ds.searches,
      successes: ds.successes,
      successShare: share(ds.successes, ds.searches),
    },
    scoresStaleMinutes,
    unrewrittenLeads7d: backlogRows[0].n,
    hiddenAggregatorLeadShare72h: share(
      hiddenRows[0].hidden,
      hiddenRows[0].total,
    ),
    singletonShare: share(singletonRows[0].singles, singletonRows[0].total),
  };

  const breaches: string[] = [];
  if (articlesIngested24h === 0) breaches.push("no_articles_ingested_24h");
  if (cronErrors24h > 0) breaches.push(`cron_errors_24h:${cronErrors24h}`);
  if (
    rw.attempts >= 20 &&
    (metrics.rewrite.llmErrorShare ?? 0) > THRESHOLDS.rewriteLlmErrorShareMax
  ) {
    breaches.push(
      `rewrite_llm_error_share:${metrics.rewrite.llmErrorShare?.toFixed(2)}`,
    );
  }
  if (
    pf.attempted >= 50 &&
    (metrics.prefetch.successShare ?? 1) < THRESHOLDS.prefetchSuccessShareMin
  ) {
    breaches.push(
      `prefetch_success_share:${metrics.prefetch.successShare?.toFixed(2)}`,
    );
  }
  if (
    ds.searches >= 10 &&
    (metrics.discovery.successShare ?? 1) < THRESHOLDS.discoverySuccessShareMin
  ) {
    breaches.push(
      `discovery_success_share:${metrics.discovery.successShare?.toFixed(2)}`,
    );
  }
  if (
    scoresStaleMinutes !== null &&
    scoresStaleMinutes > THRESHOLDS.scoresStaleMinutesMax
  ) {
    breaches.push(`cluster_scores_stale_minutes:${scoresStaleMinutes}`);
  }

  const report: HealthReport = {
    ok: breaches.length === 0,
    windowHours,
    breaches,
    metrics,
  };

  if (opts.closePool) await endPool();
  return report;
}

function printHuman(report: HealthReport) {
  const m = report.metrics;
  const pct = (v: number | null) =>
    v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
  console.log("🩺 Pipeline health");
  console.log("═".repeat(50));
  console.log(`  Window:               ${report.windowHours}h`);
  console.log(`  Ingested (24h):       ${m.articlesIngested24h}`);
  console.log(`  Cron errors (24h):    ${m.cronErrors24h}`);
  console.log(
    `  Rewrite:              ${m.rewrite.attempts} attempts, llm_error ${pct(m.rewrite.llmErrorShare)}, accepted ${pct(m.rewrite.acceptShare)}`,
  );
  console.log(
    `  Prefetch:             ${m.prefetch.attempted} attempted, success ${pct(m.prefetch.successShare)}`,
  );
  console.log(
    `  Discovery:            ${m.discovery.searches} searches, success ${pct(m.discovery.successShare)}`,
  );
  console.log(`  Scores stale:         ${m.scoresStaleMinutes ?? "n/a"} min`);
  console.log(`  Unrewritten leads 7d: ${m.unrewrittenLeads7d}`);
  console.log(`  Hidden agg leads 72h: ${pct(m.hiddenAggregatorLeadShare72h)}`);
  console.log(`  Singleton share:      ${pct(m.singletonShare)}`);
  if (report.ok) {
    console.log("\n✅ No threshold breaches.");
  } else {
    console.log(`\n🚨 Breaches: ${report.breaches.join(", ")}`);
  }
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const windowFlag = process.argv.find((a) => a.startsWith("--window="));
  const windowHours = windowFlag ? Number(windowFlag.split("=")[1]) : undefined;

  run({ windowHours, closePool: true })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2));
      else printHuman(report);
      process.exit(report.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      endPool().finally(() => process.exit(2));
    });
}
