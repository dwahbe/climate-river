import type { NextConfig } from "next";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://climateriver.org",
  "https://www.climateriver.org",
  "http://localhost:3000",
];

function resolveAllowedOrigins(): string[] {
  const env = globalThis.process?.env ?? {};
  const envOrigins =
    env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(",").map((origin) =>
      origin.trim(),
    ) ?? [];

  const vercelOrigin = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null;

  const merged = [
    ...envOrigins,
    vercelOrigin,
    ...DEFAULT_ALLOWED_ORIGINS,
  ].filter(Boolean) as string[];

  return Array.from(new Set(merged));
}

const nextConfig: NextConfig = {
  // Keep jsdom unbundled so its transitive ESM deps (html-encoding-sniffer →
  // @exodus/bytes) resolve at runtime instead of crashing with ERR_REQUIRE_ESM.
  // Requires the webpack builder; Turbopack rewrites the require() and ignores
  // this directive (see package.json build script).
  serverExternalPackages: ["jsdom"],
  experimental: {
    serverActions: { allowedOrigins: resolveAllowedOrigins() },
    useCache: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.google.com",
        pathname: "/s2/favicons",
      },
    ],
  },

  async redirects() {
    return [
      {
        source: "/river",
        destination: "/",
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
