// lib/gateRejections.ts
// Keeps a capped, random sample of the items the keyword relevance gate drops
// at ingest and discovery, so the judge stage can measure what the gate misses.
// A no-op unless ARTICLE_JUDGE_ENABLED=1. Never throws: a failed insert must
// not cost an ingest run.

import { query } from "@/lib/db";
import { parseEnvFloat, parseEnvInt } from "@/lib/utils";

export type GateRejectionStage = "ingest" | "discover" | "discover-web";

export type GateRejection = {
  stage: GateRejectionStage;
  url: string;
  title: string;
  dek?: string | null;
  sourceId?: number | null;
};

const DEFAULT_SAMPLE_RATE = 0.2;
const DEFAULT_MAX_PER_RUN = 40;

let recordedThisRun = 0;
let disabledThisRun = false;

export function articleJudgeEnabled(): boolean {
  return process.env.ARTICLE_JUDGE_ENABLED === "1";
}

/** Pure sampling decision, separated so the policy can be tested. */
export function shouldSampleRejection(state: {
  enabled: boolean;
  recorded: number;
  maxPerRun: number;
  sampleRate: number;
  roll: number;
}): boolean {
  if (!state.enabled) return false;
  if (state.recorded >= state.maxPerRun) return false;
  return state.roll < state.sampleRate;
}

export async function recordGateRejection(
  rejection: GateRejection,
): Promise<void> {
  if (disabledThisRun) return;
  const sample = shouldSampleRejection({
    enabled: articleJudgeEnabled(),
    recorded: recordedThisRun,
    maxPerRun: parseEnvInt("JUDGE_REJECTION_MAX_PER_RUN", DEFAULT_MAX_PER_RUN),
    sampleRate: parseEnvFloat(
      "JUDGE_REJECTION_SAMPLE_RATE",
      DEFAULT_SAMPLE_RATE,
    ),
    roll: Math.random(),
  });
  if (!sample) return;

  const url = rejection.url.trim();
  const title = rejection.title.trim();
  if (!url || !title) return;

  try {
    await query(
      `INSERT INTO gate_rejections (canonical_url, title, dek, source_id, stage)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (canonical_url) DO NOTHING`,
      [
        url,
        title.slice(0, 500),
        rejection.dek?.slice(0, 2000) ?? null,
        rejection.sourceId ?? null,
        rejection.stage,
      ],
    );
    recordedThisRun += 1;
  } catch (error) {
    // Usually the table is missing (`bun run schema` not applied yet). Stop
    // trying for the rest of this run rather than failing on every item.
    disabledThisRun = true;
    console.warn(
      "⚠️  gate_rejections insert failed; sampling off for this run:",
      error instanceof Error ? error.message : error,
    );
  }
}
