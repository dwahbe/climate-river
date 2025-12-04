import { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Climate River',
    short_name: 'Climate River',
    description:
      'Climate news aggregated from trusted sources, organized by story, ranked for credibility and timeliness.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fafaf9',
    theme_color: '#18181b',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
      {
        src: '/apple-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  }
}





