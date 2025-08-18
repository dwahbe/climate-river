import * as sw from 'stopword'

export type ArticleLike = { title: string; summary?: string | null }

// Enhanced category definitions with multiple detection patterns
export const CATEGORIES = [
  {
    slug: 'policy',
    name: 'Policy',
    description: 'Government regulations, laws, and policy decisions',
    color: '#3B82F6', // blue
    keywords: [
      'epa',
      'ferc',
      'sec',
      'eu',
      'parliament',
      'regulation',
      'rule',
      'mandate',
      'standard',
      'court',
      'lawsuit',
      'bill',
      'policy',
      'permitting',
      'government',
      'federal',
      'congress',
      'senate',
      'biden',
      'trump',
      'climate law',
      'carbon tax',
      'emissions standard',
    ],
    patterns: [
      /(epa|ferc|sec|parliament|regulation|rule|mandate|standard|court|lawsuit|bill|policy|permitting)/i,
      /(government|federal|congress|senate|house|administration|regulatory|compliance)/i,
      /(carbon tax|emissions? standard|climate law|environmental law)/i,
    ],
  },
  {
    slug: 'science',
    name: 'Science',
    description: 'Research, studies, and scientific discoveries',
    color: '#10B981', // emerald
    keywords: [
      'study',
      'paper',
      'journal',
      'nature',
      'science',
      'pnas',
      'observations',
      'model',
      'dataset',
      'peer-reviewed',
      'research',
      'university',
      'climate model',
      'temperature',
      'co2',
      'greenhouse gas',
    ],
    patterns: [
      /(study|paper|journal|nature|science|pnas|observations|model|dataset|peer-reviewed)/i,
      /(research|university|scientists?|climate model|temperature|co2)/i,
      /(greenhouse gas|carbon dioxide|methane|emissions data)/i,
    ],
  },
  {
    slug: 'energy',
    name: 'Energy',
    description: 'Renewable energy, EVs, and energy infrastructure',
    color: '#F59E0B', // amber
    keywords: [
      'solar',
      'wind',
      'battery',
      'ev',
      'grid',
      'transmission',
      'storage',
      'renewable',
      'hydrogen',
      'nuclear',
      'geothermal',
      'heat pump',
      'clean energy',
      'fossil fuel',
      'oil',
      'gas',
      'coal',
    ],
    patterns: [
      /(solar|wind|battery|evs?|grid|transmission|storage|renewable|hydrogen|nuclear|geothermal|heat pump)/i,
      /(clean energy|fossil fuel|oil|gas|coal|petroleum|fracking)/i,
      /(power plant|utility|electricity|energy transition)/i,
    ],
  },
  {
    slug: 'impacts',
    name: 'Impacts',
    description: 'Climate impacts and extreme weather',
    color: '#DC2626', // red
    keywords: [
      'heatwave',
      'wildfire',
      'flood',
      'drought',
      'hurricane',
      'storm',
      'sea level',
      'record heat',
      'smoke',
      'air quality',
      'extreme weather',
      'climate change',
      'global warming',
      'temperature rise',
    ],
    patterns: [
      /(heatwave|wildfire|flood|drought|hurricane|storm|sea[- ]?level|record heat|smoke|air quality)/i,
      /(extreme weather|climate change|global warming|temperature rise)/i,
      /(melting|ice sheet|glacier|arctic|coral reef|ecosystem)/i,
    ],
  },
  {
    slug: 'finance',
    name: 'Finance',
    description: 'Green finance, investments, and ESG',
    color: '#059669', // emerald-600
    keywords: [
      'bank',
      'bond',
      'finance',
      'investment',
      'fund',
      'credit',
      'loan',
      'insurance',
      'insurer',
      'rating',
      'esg',
      'green bond',
      'climate fund',
      'carbon credit',
      'carbon market',
    ],
    patterns: [
      /(bank|bond|finance|investment|fund|credit|loan|insurance|insurer|ratings?)/i,
      /(esg|green bond|climate fund|carbon credit|carbon market)/i,
      /(sustainable finance|climate risk|stranded asset)/i,
    ],
  },
  {
    slug: 'tech',
    name: 'Tech',
    description: 'Climate technology and innovation',
    color: '#8B5CF6', // violet
    keywords: [
      'carbon capture',
      'ccs',
      'direct air capture',
      'geoengineering',
      'climate tech',
      'clean tech',
      'artificial intelligence',
      'ai',
      'machine learning',
      'innovation',
      'startup',
      'technology',
    ],
    patterns: [
      /(carbon capture|ccs|direct air capture|geoengineering|climate tech|clean tech)/i,
      /(artificial intelligence|ai|machine learning|innovation|startup|technology)/i,
      /(carbon removal|negative emissions|breakthrough|patent)/i,
    ],
  },
  {
    slug: 'justice',
    name: 'Justice',
    description: 'Environmental justice and equity',
    color: '#7C3AED', // violet-600
    keywords: [
      'frontline',
      'environmental justice',
      'ej',
      'indigenous',
      'tribal',
      'community-led',
      'overburdened',
      'disproportionate',
      'equity',
      'racism',
      'low-income',
      'vulnerable',
    ],
    patterns: [
      /(frontline|environmental justice|ej|indigenous|tribal|community-led|overburdened|disproportionate)/i,
      /(equity|racism|low-income|vulnerable|marginalized|disadvantaged)/i,
      /(environmental racism|climate justice|just transition)/i,
    ],
  },
  {
    slug: 'business',
    name: 'Business',
    description: 'Corporate climate action and green business',
    color: '#0891B2', // cyan-600
    keywords: [
      'corporate',
      'company',
      'business',
      'ceo',
      'net zero',
      'carbon neutral',
      'sustainability',
      'supply chain',
      'green products',
      'climate pledge',
      'esg reporting',
    ],
    patterns: [
      /(corporate|company|business|ceo|net zero|carbon neutral|sustainability)/i,
      /(supply chain|green products|climate pledge|esg reporting)/i,
      /(sustainable business|climate commitment|decarbonization)/i,
    ],
  },
] as const

export type CategorySlug = (typeof CATEGORIES)[number]['slug']

export interface CategoryScore {
  slug: CategorySlug
  confidence: number
  reasons: string[]
}

// Enhanced tagging with confidence scoring
export function tagArticle(a: ArticleLike): string[] {
  const scores = categorizeArticle(a)
  // Return categories with confidence > 0.3
  return scores.filter((s) => s.confidence > 0.3).map((s) => s.slug)
}

// New function for detailed categorization with confidence scores
export function categorizeArticle(a: ArticleLike): CategoryScore[] {
  const text = [a.title, a.summary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .slice(0, 1200)
  const results: CategoryScore[] = []

  for (const category of CATEGORIES) {
    let confidence = 0
    const reasons: string[] = []

    // Pattern matching (weighted heavily)
    for (const pattern of category.patterns) {
      if (pattern.test(text)) {
        confidence += 0.4
        reasons.push(`Pattern match: ${pattern.source}`)
      }
    }

    // Keyword matching (lighter weight)
    const matchedKeywords = category.keywords.filter((keyword) =>
      text.includes(keyword.toLowerCase())
    )

    if (matchedKeywords.length > 0) {
      confidence += Math.min(0.3, matchedKeywords.length * 0.1)
      reasons.push(`Keywords: ${matchedKeywords.slice(0, 3).join(', ')}`)
    }

    // Cap confidence at 1.0
    confidence = Math.min(1.0, confidence)

    results.push({
      slug: category.slug,
      confidence,
      reasons,
    })
  }

  // Sort by confidence, highest first
  return results.sort((a, b) => b.confidence - a.confidence)
}

// Helper to get category metadata
export function getCategoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug)
}

// Helper to get primary category (highest confidence)
export function getPrimaryCategory(a: ArticleLike): CategoryScore | null {
  const scores = categorizeArticle(a)
  return scores.length > 0 && scores[0].confidence > 0.3 ? scores[0] : null
}
