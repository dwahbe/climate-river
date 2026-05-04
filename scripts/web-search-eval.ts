import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText } from "ai";

import {
  buildSystemPrompt,
  buildUserPrompt,
  DEFAULT_WEB_SEARCH_PROFILES,
  WEB_SEARCH_MODEL_PRICING,
  WEB_SEARCH_TOOL_CALL_COST_USD,
  type WebSearchProfile,
} from "@/config/webSearchProfiles";
import { CURATED_CLIMATE_OUTLETS } from "@/config/climateOutlets";
import { defaultEvalOutDir, median, parseCliArg } from "@/lib/evalCli";
import { resolveModel } from "@/lib/evalProviders";
import { mapLimit } from "@/lib/utils";
import {
  isLikelyFabricatedUrl,
  parseWebSearchJson,
  rootDomain,
} from "./discover-web";

// AI SDK package re-exports openai for tool definitions; import lazily.
async function loadOpenAITools() {
  const { openai } = await import("@ai-sdk/openai");
  return openai;
}

type Scenario = {
  id: string;
  /** Outlets to ask the model to find articles for. */
  domains: string[];
  /** Outlet names + prompt hints used to render the user prompt. */
  descriptors: string[];
  freshHours: number;
  resultLimit: number;
};

type RawResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source?: string;
};

type CallRecord = {
  scenarioId: string;
  profileId: string;
  modelId: string;
  provider: string;
  parseOk: boolean;
  rawResultCount: number;
  results: RawResult[];
  // quality metrics
  domainCompliantCount: number;
  freshnessCompliantCount: number;
  fabricatedUrlCount: number;
  reachableCount: number | null;
  reachabilityCheckedCount: number | null;
  validResultCount: number; // passes parse + domain + freshness + non-fabricated
  // operations
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  estimatedCostUsd: number | null;
  costPerValidResultUsd: number | null;
  errorMessage: string | null;
};

type CliOptions = {
  profiles?: string[];
  outDir?: string;
  scenariosOnly?: string[];
  skipReachability: boolean;
  concurrency: number;
  repeat: number;
};

const DEFAULT_CONCURRENCY = 2;

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    skipReachability: false,
    concurrency: DEFAULT_CONCURRENCY,
    repeat: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    let m = parseCliArg(argv, i, "--profiles");
    if (m) {
      opts.profiles = m.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += m.skip;
      continue;
    }
    m = parseCliArg(argv, i, "--out-dir");
    if (m) {
      opts.outDir = m.value;
      i += m.skip;
      continue;
    }
    m = parseCliArg(argv, i, "--scenarios");
    if (m) {
      opts.scenariosOnly = m.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += m.skip;
      continue;
    }
    m = parseCliArg(argv, i, "--concurrency");
    if (m) {
      const n = Number(m.value);
      if (Number.isFinite(n)) opts.concurrency = Math.max(1, Math.floor(n));
      i += m.skip;
      continue;
    }
    m = parseCliArg(argv, i, "--repeat");
    if (m) {
      const n = Number(m.value);
      if (Number.isFinite(n)) opts.repeat = Math.max(1, Math.floor(n));
      i += m.skip;
      continue;
    }
    if (argv[i] === "--skip-reachability") {
      opts.skipReachability = true;
    }
  }

  return opts;
}

function defaultOutDir() {
  return defaultEvalOutDir("web-search-evals");
}

function findOutlet(domain: string) {
  return CURATED_CLIMATE_OUTLETS.find((o) => o.domain === domain);
}

function makeDescriptor(domain: string): string {
  const outlet = findOutlet(domain);
  if (!outlet) return domain;
  return outlet.promptHint
    ? `${outlet.name} (${outlet.promptHint})`
    : outlet.name;
}

/**
 * Scenarios mirror the per-batch shape of the production OpenAI fallback:
 * a small group of outlets that Tavily often misses, asked to return
 * combined articles. Each scenario is run once per profile.
 */
function buildScenarios(): Scenario[] {
  const tavilyOftenMisses: Scenario[] = [
    {
      id: "single-iea",
      domains: ["iea.org"],
      descriptors: [makeDescriptor("iea.org")],
      freshHours: 72,
      resultLimit: 5,
    },
    {
      id: "single-wri",
      domains: ["wri.org"],
      descriptors: [makeDescriptor("wri.org")],
      freshHours: 72,
      resultLimit: 5,
    },
    {
      id: "batch-thinktanks",
      domains: ["iea.org", "wri.org", "ember-climate.org"],
      descriptors: [
        makeDescriptor("iea.org"),
        makeDescriptor("wri.org"),
        makeDescriptor("ember-climate.org"),
      ],
      freshHours: 72,
      resultLimit: 6,
    },
    {
      id: "batch-paywalled-flagships",
      domains: ["nytimes.com", "ft.com", "bloomberg.com"],
      descriptors: [
        makeDescriptor("nytimes.com"),
        makeDescriptor("ft.com"),
        makeDescriptor("bloomberg.com"),
      ],
      freshHours: 72,
      resultLimit: 6,
    },
    {
      id: "batch-mixed-tier",
      domains: [
        "carbonbrief.org",
        "grist.org",
        "theguardian.com",
        "reuters.com",
      ],
      descriptors: [
        makeDescriptor("carbonbrief.org"),
        makeDescriptor("grist.org"),
        makeDescriptor("theguardian.com"),
        makeDescriptor("reuters.com"),
      ],
      freshHours: 72,
      resultLimit: 6,
    },
  ];

  return tavilyOftenMisses;
}

function urlIsInAllowlist(url: string, allowed: Set<string>): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (allowed.has(host)) return true;
    return allowed.has(rootDomain(host));
  } catch {
    return false;
  }
}

function isFresh(publishedDate: string | undefined, cutoffMs: number): boolean {
  if (!publishedDate) return false;
  const t = new Date(publishedDate).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= cutoffMs;
}

function looksLikeEmptyResponseText(text: string): boolean {
  if (text === "[]") return true;
  if (text.includes("[")) return false;
  return /\b(no qualifying|no relevant|no recent|no articles|nothing matched|nothing qualifies)\b/i.test(
    text,
  );
}

function countToolCalls(response: unknown): number {
  // Mirror production accounting (scripts/discover-web.ts:853-858):
  // prefer toolResults.length, fall back to toolCalls.length.
  const r = response as {
    toolResults?: unknown[];
    toolCalls?: unknown[];
  };
  if (Array.isArray(r.toolResults) && r.toolResults.length > 0) {
    return r.toolResults.length;
  }
  if (Array.isArray(r.toolCalls)) {
    return r.toolCalls.length;
  }
  return 0;
}

function estimateCost(
  modelId: string,
  inputTokens: number | null,
  outputTokens: number | null,
  toolCalls: number,
): number | null {
  const pricing = WEB_SEARCH_MODEL_PRICING[modelId];
  if (!pricing) return null;
  const tokenCost =
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion +
    ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion;
  return tokenCost + toolCalls * WEB_SEARCH_TOOL_CALL_COST_USD;
}

const REACHABILITY_SKIP_HOSTS = new Set([
  "bloomberg.com",
  "carbonbrief.org",
  "economist.com",
  "ft.com",
  "nytimes.com",
  "wsj.com",
]);

async function headCheck(
  url: string,
  timeoutMs = 6000,
): Promise<boolean | null> {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (REACHABILITY_SKIP_HOSTS.has(rootDomain(host))) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ClimateRiverEval/1.0; +https://climateriver.org)",
        Accept: "text/html",
      },
    });
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 400) return true;
    // Some outlets reject HEAD; try GET as fallback.
    if (res.status === 405 || res.status === 403) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      const res2 = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller2.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ClimateRiverEval/1.0; +https://climateriver.org)",
          Accept: "text/html",
        },
      });
      clearTimeout(timer2);
      return res2.status >= 200 && res2.status < 400;
    }
    return false;
  } catch {
    return false;
  }
}

async function runScenarioForProfile(
  scenario: Scenario,
  profile: WebSearchProfile,
  opts: { skipReachability: boolean },
): Promise<CallRecord> {
  const allowedHosts = new Set(scenario.domains.map((d) => d.toLowerCase()));
  const cutoffMs = Date.now() - scenario.freshHours * 60 * 60 * 1000;
  const startedAt = Date.now();

  const baseRecord: CallRecord = {
    scenarioId: scenario.id,
    profileId: profile.id,
    modelId: profile.modelId,
    provider: profile.provider,
    parseOk: false,
    rawResultCount: 0,
    results: [],
    domainCompliantCount: 0,
    freshnessCompliantCount: 0,
    fabricatedUrlCount: 0,
    reachableCount: null,
    reachabilityCheckedCount: null,
    validResultCount: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    estimatedCostUsd: null,
    costPerValidResultUsd: null,
    errorMessage: null,
  };

  try {
    const openai = await loadOpenAITools();
    const model = await resolveModel(profile.provider, profile.modelId);

    const promptInputs = {
      freshHours: scenario.freshHours,
      domains: scenario.domains,
      descriptors: scenario.descriptors,
      resultLimit: scenario.resultLimit,
    };
    const result = await generateText({
      model,
      system: buildSystemPrompt(profile.promptVariant, promptInputs),
      prompt: buildUserPrompt(profile.promptVariant, promptInputs),
      tools: {
        webSearch: openai.tools.webSearch({
          searchContextSize: profile.searchContextSize ?? "medium",
        }),
      },
      toolChoice: "auto",
      maxOutputTokens: profile.maxOutputTokens,
      providerOptions: {
        openai: { maxCompletionTokens: profile.maxOutputTokens },
      },
      abortSignal: AbortSignal.timeout(60_000),
    });

    baseRecord.latencyMs = Date.now() - startedAt;
    const usage =
      (result as unknown as { totalUsage?: typeof result.usage }).totalUsage ??
      result.usage;
    baseRecord.inputTokens = usage?.inputTokens ?? null;
    baseRecord.outputTokens = usage?.outputTokens ?? null;
    baseRecord.toolCalls = countToolCalls(result);

    const parsed = parseWebSearchJson(result.text || "", scenario.id);
    const text = (result.text || "").trim();
    // parseOk = JSON-shaped response, even if empty. A short prose response
    // like "No qualifying articles found." is treated as a soft empty return,
    // not a parse failure — it's the model honestly saying nothing matched.
    baseRecord.parseOk = parsed.length > 0 || looksLikeEmptyResponseText(text);
    baseRecord.rawResultCount = parsed.length;
    baseRecord.results = parsed.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      publishedDate: r.publishedDate,
      source: r.source,
    }));

    let domainOk = 0;
    let freshOk = 0;
    let fabricated = 0;
    const validUrls: string[] = [];
    for (const r of parsed) {
      const dOk = urlIsInAllowlist(r.url, allowedHosts);
      const fOk = isFresh(r.publishedDate, cutoffMs);
      const fab = isLikelyFabricatedUrl(r.url);
      if (dOk) domainOk++;
      if (fOk) freshOk++;
      if (fab) fabricated++;
      if (dOk && fOk && !fab) validUrls.push(r.url);
    }
    baseRecord.domainCompliantCount = domainOk;
    baseRecord.freshnessCompliantCount = freshOk;
    baseRecord.fabricatedUrlCount = fabricated;
    baseRecord.validResultCount = validUrls.length;

    if (!opts.skipReachability && validUrls.length > 0) {
      const reachableFlags = await mapLimit(validUrls, 4, headCheck);
      const checkedFlags = reachableFlags.filter((flag) => flag !== null);
      baseRecord.reachabilityCheckedCount = checkedFlags.length;
      baseRecord.reachableCount = checkedFlags.filter(Boolean).length;
    }

    baseRecord.estimatedCostUsd = estimateCost(
      profile.modelId,
      baseRecord.inputTokens,
      baseRecord.outputTokens,
      baseRecord.toolCalls,
    );
    if (
      baseRecord.estimatedCostUsd != null &&
      baseRecord.validResultCount > 0
    ) {
      baseRecord.costPerValidResultUsd =
        baseRecord.estimatedCostUsd / baseRecord.validResultCount;
    }

    return baseRecord;
  } catch (error) {
    baseRecord.latencyMs = Date.now() - startedAt;
    baseRecord.errorMessage =
      error instanceof Error ? error.message : "unknown_error";
    return baseRecord;
  }
}

function resolveProfiles(opts: CliOptions): WebSearchProfile[] {
  if (!opts.profiles || opts.profiles.length === 0) {
    return DEFAULT_WEB_SEARCH_PROFILES;
  }
  const filtered = DEFAULT_WEB_SEARCH_PROFILES.filter((p) =>
    opts.profiles!.includes(p.id),
  );
  if (filtered.length === 0) {
    const available = DEFAULT_WEB_SEARCH_PROFILES.map((p) => p.id).join(", ");
    throw new Error(`No matching profiles. Available: ${available}`);
  }
  return filtered;
}

function resolveScenarios(opts: CliOptions): Scenario[] {
  const all = buildScenarios();
  if (!opts.scenariosOnly || opts.scenariosOnly.length === 0) return all;
  const filtered = all.filter((s) => opts.scenariosOnly!.includes(s.id));
  if (filtered.length === 0) {
    const available = all.map((s) => s.id).join(", ");
    throw new Error(`No matching scenarios. Available: ${available}`);
  }
  return filtered;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function buildSummaryMarkdown(records: CallRecord[]): string {
  const profileIds = [...new Set(records.map((r) => r.profileId))];
  const lines: string[] = [
    "# Web Search Eval Summary",
    "",
    `Profiles: ${profileIds.length}`,
    `Scenarios: ${new Set(records.map((r) => r.scenarioId)).size}`,
    `Total calls: ${records.length}`,
    "",
    "| Profile | Calls | Parse OK | Raw results | Valid (domain+fresh+real) | Domain comply | Fresh comply | Fabricated | Reachable | Tool calls/call (avg) | Latency p50 | Total cost | Cost/valid |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const pid of profileIds) {
    const arm = records.filter((r) => r.profileId === pid);
    const totalRaw = arm.reduce((s, r) => s + r.rawResultCount, 0);
    const totalDomain = arm.reduce((s, r) => s + r.domainCompliantCount, 0);
    const totalFresh = arm.reduce((s, r) => s + r.freshnessCompliantCount, 0);
    const totalFab = arm.reduce((s, r) => s + r.fabricatedUrlCount, 0);
    const totalValid = arm.reduce((s, r) => s + r.validResultCount, 0);
    const reachableSubsetCount = arm.filter(
      (r) => r.reachableCount !== null,
    ).length;
    const totalReachable = arm.reduce((s, r) => s + (r.reachableCount ?? 0), 0);
    const reachableDenominator = arm.reduce(
      (s, r) => s + (r.reachabilityCheckedCount ?? 0),
      0,
    );
    const parseOkCount = arm.filter((r) => r.parseOk).length;
    const totalCost = arm.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
    const costPerValid = totalValid > 0 ? totalCost / totalValid : null;
    const latencyP50 =
      median(arm.map((r) => r.latencyMs).filter((v) => v > 0)) ?? 0;
    const avgToolCalls =
      arm.reduce((s, r) => s + r.toolCalls, 0) / Math.max(1, arm.length);

    lines.push(
      `| ${pid} | ${arm.length} | ${parseOkCount}/${arm.length} | ${totalRaw} | ${totalValid} | ${pct(totalDomain, totalRaw)} | ${pct(totalFresh, totalRaw)} | ${totalFab} | ${reachableSubsetCount > 0 ? `${totalReachable}/${reachableDenominator}` : "n/a"} | ${avgToolCalls.toFixed(2)} | ${latencyP50.toFixed(0)}ms | $${totalCost.toFixed(4)} | ${costPerValid != null ? `$${costPerValid.toFixed(4)}` : "n/a"} |`,
    );
  }

  lines.push("", "## Per-scenario raw counts", "");
  const scenarioIds = [...new Set(records.map((r) => r.scenarioId))];
  lines.push(
    `| Scenario | ${profileIds.map((p) => `${p} (valid/raw)`).join(" | ")} |`,
    `| --- | ${profileIds.map(() => "---").join(" | ")} |`,
  );
  for (const sid of scenarioIds) {
    const cells = profileIds.map((pid) => {
      const r = records.find(
        (x) => x.scenarioId === sid && x.profileId === pid,
      );
      if (!r) return "—";
      if (r.errorMessage) return `error`;
      return `${r.validResultCount}/${r.rawResultCount}`;
    });
    lines.push(`| ${sid} | ${cells.join(" | ")} |`);
  }

  const errored = records.filter((r) => r.errorMessage);
  if (errored.length > 0) {
    lines.push("", "## Errors", "");
    for (const e of errored) {
      lines.push(`- **${e.profileId}** / ${e.scenarioId}: ${e.errorMessage}`);
    }
  }

  return lines.join("\n") + "\n";
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const profiles = resolveProfiles(opts);
  const scenarios = resolveScenarios(opts);
  const outDir = opts.outDir || defaultOutDir();

  const totalCalls = profiles.length * scenarios.length * opts.repeat;
  console.log(
    `🧪 Web search eval: ${profiles.length} profiles × ${scenarios.length} scenarios${opts.repeat > 1 ? ` × ${opts.repeat} repeats` : ""} = ${totalCalls} calls`,
  );
  console.log(`   Output: ${outDir}`);
  if (opts.skipReachability) {
    console.log("   (HEAD reachability checks disabled)");
  }

  const tasks: Array<{
    scenario: Scenario;
    profile: WebSearchProfile;
    repeatIdx: number;
  }> = [];
  for (let repeatIdx = 0; repeatIdx < opts.repeat; repeatIdx++) {
    for (const profile of profiles) {
      for (const scenario of scenarios) {
        tasks.push({ scenario, profile, repeatIdx });
      }
    }
  }

  const records = await mapLimit(tasks, opts.concurrency, async (task) => {
    const label =
      opts.repeat > 1
        ? `${task.profile.id} / ${task.scenario.id} #${task.repeatIdx + 1}`
        : `${task.profile.id} / ${task.scenario.id}`;
    console.log(`  → ${label}`);
    const r = await runScenarioForProfile(task.scenario, task.profile, {
      skipReachability: opts.skipReachability,
    });
    if (r.errorMessage) {
      console.warn(`    ⚠️  error: ${r.errorMessage.substring(0, 120)}`);
    } else {
      console.log(
        `    ✓ ${r.validResultCount}/${r.rawResultCount} valid · ${r.toolCalls} tool calls · $${(r.estimatedCostUsd ?? 0).toFixed(4)}`,
      );
    }
    return r;
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "outputs.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(outDir, "summary.md"),
    buildSummaryMarkdown(records),
    "utf8",
  );

  console.log(`\n✅ Eval artifacts written to ${outDir}`);
  console.log(`   Open ${path.join(outDir, "summary.md")} for results.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Eval failed:", error);
      process.exit(1);
    });
}
