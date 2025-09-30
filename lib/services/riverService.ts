// lib/services/riverService.ts
import { getClustersForRiver } from '@/lib/repositories/clusterRepository'
import type { Cluster, RiverFilters } from '@/lib/models/cluster'

/**
 * Get river data for the homepage
 * This is the main service function that orchestrates data fetching
 */
export async function getRiverData(filters: RiverFilters): Promise<Cluster[]> {
  // Validate filters
  validateFilters(filters)

  try {
    // Fetch clusters from repository
    const clusters = await getClustersForRiver(filters)

    // Apply any business logic transformations here if needed
    return clusters
  } catch (error) {
    console.error('Service error in getRiverData:', error)
    throw error
  }
}

/**
 * Validate river filters
 * Ensures the filters are valid before passing to repository
 */
function validateFilters(filters: RiverFilters): void {
  // Validate view
  const validViews = ['latest', 'top']
  const validCategories = [
    'justice',
    'government',
    'business',
    'tech',
    'impacts',
    'research',
  ]

  // If it's not a standard view, check if it's a valid category
  if (!validViews.includes(filters.view)) {
    if (filters.category && !validCategories.includes(filters.category)) {
      throw new Error(`Invalid category: ${filters.category}`)
    }
  }

  // Validate window hours if provided
  if (filters.windowHours !== undefined) {
    if (filters.windowHours < 1 || filters.windowHours > 720) {
      throw new Error('Window hours must be between 1 and 720 (30 days)')
    }
  }

  // Validate limit if provided
  if (filters.limit !== undefined) {
    if (filters.limit < 1 || filters.limit > 100) {
      throw new Error('Limit must be between 1 and 100')
    }
  }
}
