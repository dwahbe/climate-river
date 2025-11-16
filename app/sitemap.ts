import { MetadataRoute } from 'next'
import { CATEGORIES } from '@/lib/tagger'

export const revalidate = 3600 // Revalidate every hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://climateriver.org'

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 1,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/categories`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
  ]

  // Category pages
  const categoryPages: MetadataRoute.Sitemap = CATEGORIES.map((category) => ({
    url: `${baseUrl}/categories/${category.slug}`,
    lastModified: new Date(),
    changeFrequency: 'hourly' as const,
    priority: 0.8,
  }))

  // SEO Strategy: Don't include story pages in sitemap
  // Story pages are noindexed - Climate River ranks for aggregation, not individual stories
  // Focus crawl budget on pages that matter: home, categories, about
  // This follows the Techmeme approach: be the destination, not the story source

  return [...staticPages, ...categoryPages]
}
