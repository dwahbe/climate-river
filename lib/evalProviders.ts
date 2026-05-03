import type { LanguageModelV3 } from "@ai-sdk/provider";

type ProviderFactory = (modelId: string) => LanguageModelV3;

/**
 * Explicit provider loaders for installed packages. Providers not listed here
 * are resolved automatically via dynamic import of @ai-sdk/<name>, so adding
 * an entry is optional — it just avoids the dynamic fallback overhead.
 */
const PROVIDER_LOADERS: Record<string, () => Promise<ProviderFactory>> = {
  openai: async () => {
    const { openai } = await import("@ai-sdk/openai");
    return (modelId) => openai(modelId);
  },
  // Vercel AI Gateway — routes "<provider>/<model>" through ai-gateway.vercel.sh
  // using AI_GATEWAY_API_KEY. Lets us test Anthropic/Google/etc without
  // installing per-provider SDK packages.
  gateway: async () => {
    const { gateway } = await import("ai");
    return (modelId) => gateway(modelId);
  },
};

/**
 * Fallback loader for providers not explicitly listed above.
 * Attempts `import("@ai-sdk/<provider>")` and expects a default export
 * or a named export matching the provider name that acts as a model factory.
 */
async function loadProviderDynamic(provider: string): Promise<ProviderFactory> {
  const pkg = `@ai-sdk/${provider}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import(/* webpackIgnore: true */ pkg);
  } catch {
    throw new Error(
      `Provider "${provider}" is not installed. Run: bun add ${pkg}`,
    );
  }
  const factory = mod[provider] ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Provider package "${pkg}" does not export a "${provider}" or default model factory`,
    );
  }
  return (modelId) => factory(modelId);
}

const resolvedFactories = new Map<string, ProviderFactory>();

/**
 * Resolve a provider + modelId into a LanguageModel instance.
 * Lazily imports the provider package on first use and caches the factory.
 */
export async function resolveModel(
  provider: string,
  modelId: string,
): Promise<LanguageModelV3> {
  let factory = resolvedFactories.get(provider);
  if (!factory) {
    const loader = PROVIDER_LOADERS[provider];
    factory = loader ? await loader() : await loadProviderDynamic(provider);
    resolvedFactories.set(provider, factory);
  }
  return factory(modelId);
}
