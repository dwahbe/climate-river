const DEFAULT_ALLOWED_ORIGINS = [
  "https://climateriver.org",
  "https://www.climateriver.org",
  "http://localhost:3000",
];

function resolveAllowedOrigins() {
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
  ].filter(Boolean);

  return Array.from(new Set(merged));
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { allowedOrigins: resolveAllowedOrigins() },
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
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
