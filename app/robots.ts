import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/api/og', '/feed.xml'],
        disallow: ['/api/'],
      },
    ],
    sitemap: 'https://climateriver.org/sitemap.xml',
  }
}
