/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { allowedOrigins: ['*'] } },

  async redirects() {
    return [
      {
        source: '/river',
        destination: '/',
        permanent: false,
      },
    ]
  },
}

export default nextConfig
