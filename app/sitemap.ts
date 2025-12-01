import { MetadataRoute } from 'next'
import { CATEGORIES } from '@/lib/tagger'
import * as DB from '@/lib/db'

export const revalidate = 3600 // Revalidate every hour

async function getLatestContentUpdate(): Promise<Date> {
  try {
    const { rows } = await DB.query<{ max_date: string }>(
      `SELECT MAX(a.published_at) as max_date 
       FROM cluster_scores cs 
       JOIN articles a ON a.id = cs.lead_article_id 
       WHERE a.published_at > NOW() - INTERVAL '7 days'`
    )
    if (rows[0]?.max_date) {
      return new Date(rows[0].max_date)
    }
  } catch (error) {
    console.error('Error fetching latest content update:', error)
  }
  return new Date()
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://climateriver.org'
  const latestUpdate = await getLatestContentUpdate()

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: latestUpdate,
      changeFrequency: 'hourly',
      priority: 1,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date('2025-11-25'), // About page rarely changes
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/categories`,
      lastModified: latestUpdate,
      changeFrequency: 'daily',
      priority: 0.9,
    },
  ]

  // Category pages
  const categoryPages: MetadataRoute.Sitemap = CATEGORIES.map((category) => ({
    url: `${baseUrl}/categories/${category.slug}`,
    lastModified: latestUpdate,
    changeFrequency: 'hourly' as const,
    priority: 0.8,
  }))

  // SEO Strategy: Don't include story pages in sitemap
  // Story pages are noindexed - Climate River ranks for aggregation, not individual stories
  // Focus crawl budget on pages that matter: home, categories, about
  // This follows the Techmeme approach: be the destination, not the story source

  return [...staticPages, ...categoryPages]
}
