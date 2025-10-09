import { MetadataRoute } from 'next'
import * as DB from '@/lib/db'
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

  // Get recent cluster IDs (last 30 days)
  const { rows } = await DB.query<{ cluster_id: number; published_at: string }>(
    `
    SELECT DISTINCT
      cs.cluster_id,
      a.published_at
    FROM cluster_scores cs
    JOIN articles a ON a.id = cs.lead_article_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
    ORDER BY a.published_at DESC
    LIMIT 500
    `
  )

  const clusterPages: MetadataRoute.Sitemap = rows.map((row) => ({
    url: `${baseUrl}/river/${row.cluster_id}`,
    lastModified: new Date(row.published_at),
    changeFrequency: 'daily' as const,
    priority: 0.6,
  }))

  return [...staticPages, ...categoryPages, ...clusterPages]
}
