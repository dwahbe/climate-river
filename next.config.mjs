/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { allowedOrigins: ['*'] } },

  async headers() {
    return process.env.VERCEL_ENV === 'preview'
      ? [
          {
            source: '/:path*',
            headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
          },
        ]
      : []
  },
}

export default nextConfig
