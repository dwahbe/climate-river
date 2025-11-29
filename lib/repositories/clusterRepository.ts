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
  // Data-driven: 72h provides 70+ cluster buffer while ensuring freshness
  const windowHours =
    filters.windowHours || (isCategory ? 168 : isLatest ? 48 : 72)

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
    const clusters = Array.isArray(data)
      ? (data as Cluster[])
      : data
        ? ([data] as Cluster[])
        : []

    return clusters
  } catch (error) {
    console.error('Repository error fetching clusters:', error)
    throw error
  }
}

