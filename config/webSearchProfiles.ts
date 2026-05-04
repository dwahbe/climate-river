import type { ModelPricing } from "@/config/evalProfiles";

export type WebSearchPromptVariant = "v1" | "v2" | "v3" | "v4";

export type WebSearchProfile = {
  id: string;
  /** AI SDK provider key: "openai", "gateway", etc. */
  provider: string;
  /** Model ID passed to the provider factory */
  modelId: string;
  /** Token budget for the model's response */
  maxOutputTokens: number;
  /** OpenAI web_search tool context size: "low" | "medium" | "high" */
  searchContextSize?: "low" | "medium" | "high";
  /** Prompt variant — "v1" mirrors current production verbatim. */
  promptVariant: WebSearchPromptVariant;
};

/**
 * OpenAI charges a flat fee per `web_search` tool call on top of token usage.
 * As of 2026-05 the rate is $10.00 / 1k calls = $0.010/call across all models.
 */
export const WEB_SEARCH_TOOL_CALL_COST_USD = 0.01;

/**
 * Per-model pricing for cost estimation. Keyed by modelId.
 */
export const WEB_SEARCH_MODEL_PRICING: Record<string, ModelPricing> = {
  // Legacy GPT-4 family — still callable but retired from the official
  // current-models list (per OpenAI docs, 2026-05).
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // Current GPT-5.x family (2026).
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.5": { inputPerMillion: 5.0, outputPerMillion: 30.0 },
};

export type PromptInputs = {
  freshHours: number;
  domains: string[];
  descriptors: string[];
  resultLimit: number;
};

/** v1: production prompt verbatim (scripts/discover-web.ts:2036). */
function buildSystemPromptV1(inputs: PromptInputs): string {
  return `You are ClimateRiver's climate outlet curator. For each outlet you must issue at least one precise site:domain query that reflects the outlet's specialty while keeping total tool calls as low as possible. Only keep original articles published in the past ${inputs.freshHours} hours. Reject syndicated content, opinion newsletters, or aggregator redirections. Double-check that every URL's hostname belongs to the allowed domain list and drop any entry without a confirmed ISO timestamp. Respond with a JSON array sorted newest to oldest containing title, url, snippet (why the story matters), publishedDate (ISO), and source.`;
}

function buildUserPromptV1(inputs: PromptInputs): string {
  return `Provide up to ${inputs.resultLimit} combined articles across these outlets: ${inputs.descriptors.join("; ")}. Use site-specific queries (e.g., site:domain "topic") tailored to each prompt hint, and when possible include at least one qualifying link per outlet. Only include URLs from ${inputs.domains.join(", ")} or their official climate sections, ensure every item was published within the last ${inputs.freshHours} hours, and omit any link that fails those tests. Return only the JSON array sorted newest to oldest.`;
}

/** v2: explicit reject list, "quality > coverage", empty-array-as-correct. */
function buildSystemPromptV2(inputs: PromptInputs): string {
  const cutoffIso = new Date(
    Date.now() - inputs.freshHours * 60 * 60 * 1000,
  ).toISOString();
  return `You are Climate River's news curator. Climate River is a Techmeme-style aggregator: it surfaces only fresh, substantive climate news with a constant cadence of high-quality stories.

KEEP — original news reporting matching ANY of:
- Government action, legislation, regulation, lawsuits, court rulings
- Corporate climate moves: deals, M&A, investment rounds, project announcements
- Named scientific studies or data releases (with cited journal/institution)
- Breaking events: extreme weather, disasters, protests, summits in progress
- Specific financial figures, emissions data, or policy targets

REJECT — do not return URLs that are:
- Homepages, section/category pages, tag pages, daily briefs, newsletter signups
- Opinion, op-eds, editorials, columns, interviews, Q&As, podcasts, video pages
- Explainers, FAQs, "what to know" guides, evergreen reference content
- Event listings, conference pages, fellowship/award announcements
- Syndicated wire copy republished from another outlet
- Any URL where the published date is before ${cutoffIso} or missing
- Any URL whose hostname is not on the allowed list

CRITICAL: Quality > coverage. If an outlet has nothing meeting the bar, OMIT it. Do not pad results to cover every domain. Returning an empty array \`[]\` is a CORRECT response when nothing qualifies — it is not a failure.

Output: JSON array only, no preamble. Each item:
{"title":"...","url":"https://...","snippet":"one-sentence why this matters","publishedDate":"ISO 8601 with time","source":"outlet name"}

Sort newest first.`;
}

function buildUserPromptV2(inputs: PromptInputs): string {
  const cutoffIso = new Date(
    Date.now() - inputs.freshHours * 60 * 60 * 1000,
  ).toISOString();
  return `Find recent climate news from these outlets that meets the bar in the system prompt: ${inputs.descriptors.join("; ")}.

Allowed domains: ${inputs.domains.join(", ")}
Cutoff: do not include anything published before ${cutoffIso}
Maximum items: ${inputs.resultLimit}

Return only items that pass every rejection rule. If fewer than ${inputs.resultLimit} qualify, return only the qualifying ones — do not lower standards. \`[]\` is correct if nothing qualifies.

Return only the JSON array.`;
}

/** v3: v2 + date-stamped query discipline (no native recency filter exists). */
function buildSystemPromptV3(inputs: PromptInputs): string {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - inputs.freshHours * 60 * 60 * 1000,
  ).toISOString();
  const yyyy = now.getUTCFullYear();
  const monthName = now.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `You are Climate River's news curator. Climate River is a Techmeme-style aggregator: it surfaces only fresh, substantive climate news with a constant cadence of high-quality stories.

SEARCH QUERY DISCIPLINE — critical for getting fresh results:
- Today is ${now.toISOString().slice(0, 10)} (${monthName} ${yyyy}).
- Every search query you issue MUST include a recency hint. Examples:
  - GOOD: \`site:carbonbrief.org climate ${monthName} ${yyyy}\`
  - GOOD: \`site:reuters.com climate news this week\`
  - GOOD: \`site:wri.org policy ${yyyy}\`
  - BAD: \`site:carbonbrief.org climate energy environment\` (no date — returns evergreen content)
- Prefer queries with specific topics over generic "climate news" — pair the recency hint with a substantive topic from the outlet's prompt hint.

KEEP — original news reporting matching ANY of:
- Government action, legislation, regulation, lawsuits, court rulings
- Corporate climate moves: deals, M&A, investment rounds, project announcements
- Named scientific studies or data releases (with cited journal/institution)
- Breaking events: extreme weather, disasters, protests, summits in progress
- Specific financial figures, emissions data, or policy targets

REJECT — do not return URLs that are:
- Homepages, section/category pages, tag pages, daily briefs, newsletter signups
- Opinion, op-eds, editorials, columns, interviews, Q&As, podcasts, video pages
- Explainers, FAQs, "what to know" guides, evergreen reference content
- Event listings, conference pages, fellowship/award announcements
- Syndicated wire copy republished from another outlet
- Any URL where the published date is before ${cutoffIso} or missing
- Any URL whose hostname is not on the allowed list

CRITICAL: Quality > coverage. If an outlet has nothing meeting the bar, OMIT it. Do not pad results to cover every domain. Returning an empty array \`[]\` is a CORRECT response when nothing qualifies — it is not a failure.

Output: JSON array only, no preamble. Each item:
{"title":"...","url":"https://...","snippet":"one-sentence why this matters","publishedDate":"ISO 8601 with time","source":"outlet name"}

Sort newest first.`;
}

function buildUserPromptV3(inputs: PromptInputs): string {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - inputs.freshHours * 60 * 60 * 1000,
  ).toISOString();
  const yyyy = now.getUTCFullYear();
  const monthName = now.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `Find recent climate news from these outlets that meets the bar in the system prompt: ${inputs.descriptors.join("; ")}.

Allowed domains: ${inputs.domains.join(", ")}
Cutoff: do not include anything published before ${cutoffIso}
Maximum items: ${inputs.resultLimit}

Each search query you issue MUST include "${monthName} ${yyyy}" or "${yyyy}" or "this week" — never a date-less query. If a query returns mostly old results, retry with a tighter recency hint.

Return only items that pass every rejection rule. If fewer than ${inputs.resultLimit} qualify, return only the qualifying ones — do not lower standards. \`[]\` is correct if nothing qualifies.

Return only the JSON array.`;
}

/** v4: v1 + date-stamped query discipline + empty-array-is-correct framing. */
function buildSystemPromptV4(inputs: PromptInputs): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const monthName = now.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `You are ClimateRiver's climate outlet curator. For each outlet you must issue at least one precise site:domain query that reflects the outlet's specialty while keeping total tool calls as low as possible.

RECENCY: Today is ${now.toISOString().slice(0, 10)} (${monthName} ${yyyy}). Every search query you issue MUST include a date hint such as "${monthName} ${yyyy}", "${yyyy}", or "this week". A query like \`site:reuters.com climate\` will return evergreen content; a query like \`site:reuters.com climate ${monthName} ${yyyy}\` returns recent reporting. Date-stamp every query.

Only keep original articles published in the past ${inputs.freshHours} hours. Reject syndicated content, opinion newsletters, or aggregator redirections. Double-check that every URL's hostname belongs to the allowed domain list and drop any entry without a confirmed ISO timestamp.

If an outlet has no qualifying recent articles, OMIT it. An empty array \`[]\` is a correct, expected response when nothing fresh exists — do not return stale articles to fill the list.

Respond with a JSON array sorted newest to oldest containing title, url, snippet (why the story matters), publishedDate (ISO), and source.`;
}

function buildUserPromptV4(inputs: PromptInputs): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const monthName = now.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `Provide up to ${inputs.resultLimit} combined articles across these outlets: ${inputs.descriptors.join("; ")}. Use date-stamped site-specific queries (e.g., \`site:domain "topic" ${monthName} ${yyyy}\`) tailored to each prompt hint. Only include URLs from ${inputs.domains.join(", ")} or their official climate sections, ensure every item was published within the last ${inputs.freshHours} hours, and omit any link that fails those tests. Returning fewer than ${inputs.resultLimit} items is fine — \`[]\` is correct if nothing qualifies. Return only the JSON array sorted newest to oldest.`;
}

export function buildSystemPrompt(
  variant: WebSearchPromptVariant,
  inputs: PromptInputs,
): string {
  if (variant === "v4") return buildSystemPromptV4(inputs);
  if (variant === "v3") return buildSystemPromptV3(inputs);
  if (variant === "v2") return buildSystemPromptV2(inputs);
  return buildSystemPromptV1(inputs);
}

export function buildUserPrompt(
  variant: WebSearchPromptVariant,
  inputs: PromptInputs,
): string {
  if (variant === "v4") return buildUserPromptV4(inputs);
  if (variant === "v3") return buildUserPromptV3(inputs);
  if (variant === "v2") return buildUserPromptV2(inputs);
  return buildUserPromptV1(inputs);
}

export const DEFAULT_WEB_SEARCH_PROFILES: WebSearchProfile[] = [
  // Baseline: production prompt
  {
    id: "gpt-4.1-mini-v1",
    provider: "openai",
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 1500,
    searchContextSize: "medium",
    promptVariant: "v1",
  },
  {
    id: "gpt-4.1-mini-v4",
    provider: "openai",
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 1500,
    searchContextSize: "medium",
    promptVariant: "v4",
  },
];
