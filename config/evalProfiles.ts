import type { JSONObject } from "@ai-sdk/provider";

export type PromptVariant = "legacy" | "structured";

export type EvalProfile = {
  id: string;
  /** AI SDK provider key: "openai", "anthropic", "google", etc. */
  provider: string;
  /** Model ID passed to the provider factory, e.g. "gpt-4.1-mini", "claude-sonnet-4-20250514" */
  modelId: string;
  promptVariant: PromptVariant;
  retryPromptVariant: PromptVariant;
  temperature: number;
  maxOutputTokens: number;
  /** Provider-keyed options passed through to generateText() */
  providerOptions?: Record<string, JSONObject>;
};

export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

/**
 * Per-model pricing for cost estimation. Keyed by modelId.
 * Add new entries here when testing new models.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-haiku-3-5-20241022": { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  // Gateway-routed: pricing is provider's published rate (no Vercel markup).
  "anthropic/claude-haiku-4-5": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  "google/gemini-2.5-flash-lite": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
  },
  // Open-weight candidates (rates from the gateway /v1/models catalog, 2026-07).
  "openai/gpt-oss-120b": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "deepseek/deepseek-v4-flash": {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
  },
  "deepseek/deepseek-v4-pro": {
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
  },
  "alibaba/qwen3.7-plus": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "zai/glm-4.7-flash": { inputPerMillion: 0.07, outputPerMillion: 0.4 },
  "google/gemma-4-31b-it": { inputPerMillion: 0.14, outputPerMillion: 0.4 },
  "minimax/minimax-m2.7": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
};

/**
 * Default eval profiles. To add a new model comparison:
 * 1. Add pricing above
 * 2. Add a profile here (or pass --profiles to the CLI to filter)
 * 3. If using a new provider, install the SDK package: bun add @ai-sdk/<provider>
 */
export const DEFAULT_EVAL_PROFILES: EvalProfile[] = [
  {
    id: "legacy-gpt-4.1-mini",
    provider: "openai",
    modelId: "gpt-4.1-mini",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "legacy-gpt-4.1-nano",
    provider: "openai",
    modelId: "gpt-4.1-nano",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "legacy-gpt-4o-mini",
    provider: "openai",
    modelId: "gpt-4o-mini",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "legacy-gpt-5.4-nano",
    provider: "openai",
    modelId: "gpt-5.4-nano",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "structured-gpt-4.1-mini",
    provider: "openai",
    modelId: "gpt-4.1-mini",
    promptVariant: "structured",
    retryPromptVariant: "structured",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  // Gateway-routed candidates (no per-provider SDK needed; uses AI_GATEWAY_API_KEY).
  {
    id: "legacy-claude-haiku-4-5",
    provider: "gateway",
    modelId: "anthropic/claude-haiku-4-5",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "legacy-gemini-2.5-flash-lite",
    provider: "gateway",
    modelId: "google/gemini-2.5-flash-lite",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  // Open-weight candidates. Reasoning-capable models (gpt-oss, deepseek-v4,
  // minimax) get a larger token budget so thinking doesn't starve the answer;
  // the validator only sees result.text.
  {
    id: "ow-gpt-oss-120b",
    provider: "gateway",
    modelId: "openai/gpt-oss-120b",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 1024,
  },
  {
    id: "ow-deepseek-v4-flash",
    provider: "gateway",
    modelId: "deepseek/deepseek-v4-flash",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 1024,
  },
  {
    id: "ow-deepseek-v4-pro",
    provider: "gateway",
    modelId: "deepseek/deepseek-v4-pro",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 1024,
  },
  {
    id: "ow-qwen3.7-plus",
    provider: "gateway",
    modelId: "alibaba/qwen3.7-plus",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "ow-glm-4.7-flash",
    provider: "gateway",
    modelId: "zai/glm-4.7-flash",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "ow-gemma-4-31b",
    provider: "gateway",
    modelId: "google/gemma-4-31b-it",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 80,
  },
  {
    id: "ow-minimax-m2.7",
    provider: "gateway",
    modelId: "minimax/minimax-m2.7",
    promptVariant: "legacy",
    retryPromptVariant: "legacy",
    temperature: 0.15,
    maxOutputTokens: 1024,
  },
];
