// lib/repositories/clusterRepository.ts
import { createServerClient } from '@/lib/supabase/client'
import type { Cluster, RiverFilters } from '@/lib/models/cluster'

/**
 * Fetch clusters for the river homepage
 * Uses the get_river_clusters Postgres function for optimal performance
 */
export async function getClustersForRiver(
  filters: RiverFilters
): Promise<Cluster[]> {
  const supabase = createServerClient()

  const isLatest = filters.view === 'latest'
  const isCategory = !!filters.category

  // Determine time window based on view type
  const windowHours = filters.windowHours || (isCategory ? 336 : 168)

  // Determine limit based on view type
  const limit = filters.limit || (isCategory ? 15 : isLatest ? 20 : 10)

  try {
    // Call the Postgres function using RPC
    const { data, error } = await supabase.rpc('get_river_clusters', {
      p_is_latest: isLatest,
      p_window_hours: windowHours,
      p_limit: limit,
      p_category: filters.category || null,
    })

    if (error) {
      console.error('Error fetching river clusters:', error)
      throw new Error(`Failed to fetch clusters: ${error.message}`)
    }

    // The function returns JSON, parse if needed
    const clusters = Array.isArray(data) ? data : (data as any)

    return clusters || []
  } catch (error) {
    console.error('Repository error fetching clusters:', error)
    throw error
  }
}

/**
 * Get a specific cluster by ID
 * Useful for the /river/[id] page
 */
export async function getClusterById(
  clusterId: number
): Promise<Cluster | null> {
  const supabase = createServerClient()

  try {
    const { data, error } = await supabase
      .from('cluster_scores')
      .select(
        `
        cluster_id,
        size,
        score,
        lead_article_id,
        articles!cluster_scores_lead_article_id_fkey (
          id,
          title,
          rewritten_title,
          canonical_url,
          dek,
          author,
          published_at,
          publisher_name,
          publisher_homepage,
          sources (
            name,
            homepage_url
          )
        )
      `
      )
      .eq('cluster_id', clusterId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null
      }
      console.error('Error fetching cluster by ID:', error)
      throw new Error(`Failed to fetch cluster: ${error.message}`)
    }

    // Transform the data to match Cluster type
    const article = (data as any).articles
    if (!article) return null

    return {
      cluster_id: data.cluster_id,
      size: data.size,
      score: data.score,
      lead_article_id: article.id,
      lead_title: article.rewritten_title || article.title,
      lead_was_rewritten: !!article.rewritten_title,
      lead_url: article.canonical_url,
      lead_dek: article.dek,
      lead_author: article.author,
      lead_source: article.publisher_name || article.sources?.name || null,
      lead_homepage:
        article.publisher_homepage || article.sources?.homepage_url || null,
      published_at: article.published_at,
      sources_count: 0, // Will be enriched by service layer if needed
      subs: [],
      subs_total: 0,
      all_articles_by_source: {},
      lead_content_status: null, // Not fetched in this query
      lead_content_word_count: null, // Not fetched in this query
    } as Cluster
  } catch (error) {
    console.error('Repository error fetching cluster by ID:', error)
    throw error
  }
}

/**
 * Get category statistics
 * Shows how many articles are in each category
 */
export async function getCategoryStats(): Promise<
  Array<{ slug: string; name: string; count: number }>
> {
  const supabase = createServerClient()

  try {
    const { data, error } = await supabase.rpc('get_category_stats')

    if (error) {
      console.error('Error fetching category stats:', error)
      // Don't throw, return empty array
      return []
    }

    return data || []
  } catch (error) {
    console.error('Repository error fetching category stats:', error)
    return []
  }
}
