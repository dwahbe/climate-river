import * as sw from 'stopword'

export type ArticleLike = { title: string; summary?: string | null }

// Refined 6-category structure for climate news
export const CATEGORIES = [
  {
    slug: 'government',
    name: 'Government',
    description: 'Government policy, regulations, and climate laws',
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
      'administration',
      'regulatory',
      'compliance',
      'environmental law',
      'energy secretary',
      'department of energy',
      'subsidies',
      'tax credit',
      'legislation',
      'executive order',
      'white house',
      'department',
      'agency',
      'commission',
    ],
    patterns: [
      /(epa|ferc|sec|parliament|regulation|rule|mandate|standard|court|lawsuit|bill|policy|permitting)/i,
      /(government|federal|congress|senate|house|administration|regulatory|compliance)/i,
      /(carbon tax|emissions? standard|climate law|environmental law|energy secretary)/i,
      /(department of energy|subsidies|tax credit|legislation|executive order)/i,
    ],
  },
  {
    slug: 'impacts',
    name: 'Impacts',
    description:
      'Climate effects, extreme weather, and environmental consequences',
    color: '#EF4444', // red
    keywords: [
      'hurricane',
      'flood',
      'drought',
      'wildfire',
      'heatwave',
      'storm',
      'tornado',
      'cyclone',
      'sea level',
      'glacier',
      'ice sheet',
      'arctic',
      'coral',
      'species',
      'extinction',
      'ecosystem',
      'biodiversity',
      'agriculture',
      'crops',
      'water',
      'food security',
      'extreme weather',
      'climate impact',
      'environmental damage',
    ],
    patterns: [
      /(hurricane|flood|drought|wildfire|heatwave|storm|tornado|cyclone)/i,
      /(sea level|glacier|ice sheet|arctic|coral|species|extinction)/i,
      /(ecosystem|biodiversity|agriculture|crops|water|food security)/i,
    ],
  },
  {
    slug: 'tech',
    name: 'Tech',
    description: 'Clean technology, renewables, and climate solutions',
    color: '#10B981', // green
    keywords: [
      'technology',
      'innovation',
      'startup',
      'carbon capture',
      'ccus',
      'direct air capture',
      'hydrogen',
      'electric vehicle',
      'ev',
      'tesla',
      'battery',
      'smart grid',
      'artificial intelligence',
      'satellite',
      'sensor',
      'monitoring',
      'app',
      'platform',
      'software',
      'algorithm',
      'solar panel',
      'wind turbine',
      'renewable energy',
      'grid storage',
      'electricity generation',
      'nuclear power',
      'energy storage',
      'transmission line',
      'utility scale',
      'clean tech',
      'cleantech',
    ],
    patterns: [
      /(technology|innovation|startup|carbon capture|ccus|direct air capture)/i,
      /(hydrogen|electric vehicle|ev|tesla|battery|smart grid)/i,
      /(artificial intelligence|satellite|sensor|monitoring|app|platform)/i,
      /(solar panel|wind turbine|renewable energy|grid storage|energy storage)/i,
      /(nuclear power|transmission line|utility scale|clean tech|cleantech)/i,
    ],
  },
  {
    slug: 'research',
    name: 'Research',
    description: 'Climate research, studies, and scientific discoveries',
    color: '#8B5CF6', // purple
    keywords: [
      'study shows',
      'study finds',
      'study reveals',
      'research shows',
      'research finds',
      'scientists discover',
      'scientists find',
      'new research',
      'peer review',
      'journal',
      'published',
      'paper',
      'analysis shows',
      'findings show',
      'evidence shows',
      'data reveals',
      'climate model',
      'simulation',
      'peer-reviewed',
      'scientific study',
      'climate science',
      'atmospheric science',
      'oceanography',
      'ipcc report',
      'science journal',
      'nature journal',
      'science magazine',
      'research paper',
      'academic study',
      'university research',
      // Add broader but still research-specific terms
      'study',
      'research',
      'scientist',
      'scientists',
      'scientific',
      'findings',
      'data',
      'analysis',
      'report',
      'university',
      'academic',
    ],
    patterns: [
      /(study (shows|finds|reveals)|research (shows|finds)|scientists (discover|find))/i,
      /(new research|peer.?review|journal|published|paper)/i,
      /(analysis shows|findings show|evidence shows|data reveals)/i,
      /(climate model|simulation|peer.?reviewed|scientific study)/i,
      /(ipcc report|science journal|nature journal|research paper|academic)/i,
      // Add patterns that catch broader research terms but exclude news/events
      /(study|research|scientist|scientists|scientific|findings|data|analysis)(?!.*(?:heat wave|wildfire|flood|hurricane|storm))/i,
    ],
  },
  {
    slug: 'business',
    name: 'Business',
    description: 'Corporate climate action, finance, and market trends',
    color: '#06B6D4', // cyan
    keywords: [
      'company',
      'corporation',
      'business',
      'industry',
      'ceo',
      'executive',
      'sustainability',
      'net zero',
      'carbon neutral',
      'emissions reduction',
      'supply chain',
      'manufacturing',
      'retail',
      'airline',
      'shipping',
      'automotive',
      'investment',
      'funding',
      'cost',
      'price',
      'market',
      'stock',
      'bond',
      'esg',
      'carbon credit',
      'carbon market',
      'green finance',
      'climate finance',
      'sustainable finance',
      'divest',
      'pension',
      'insurance',
      'subsidy',
      'tax credit',
      'carbon pricing',
    ],
    patterns: [
      /(company|corporation|business|industry|ceo|executive)/i,
      /(sustainability|net zero|carbon neutral|emissions reduction)/i,
      /(supply chain|manufacturing|retail|airline|shipping|automotive)/i,
      /(investment|funding|cost|price|market|stock|bond)/i,
      /(esg|carbon credit|carbon market|green finance|climate finance)/i,
    ],
  },
  {
    slug: 'justice',
    name: 'Justice',
    description: 'Environmental justice, equity, and community impacts',
    color: '#EC4899', // pink
    keywords: [
      'justice',
      'equity',
      'environmental justice',
      'community',
      'indigenous',
      'tribal',
      'frontline',
      'vulnerable',
      'low income',
      'minority',
      'health',
      'pollution',
      'toxic',
      'contamination',
      'displacement',
      'adaptation',
      'resilience',
      'just transition',
      'green jobs',
      'social impact',
      'public health',
      'environmental racism',
      'climate justice',
      'collaboration',
      'grassroots',
      'activism',
      'advocate',
      'disproportionate',
      'underserved',
      'community-led',
    ],
    patterns: [
      /(justice|equity|environmental justice|community|indigenous|tribal)/i,
      /(frontline|vulnerable|low income|minority|health|pollution)/i,
      /(toxic|contamination|displacement|adaptation|resilience|just transition)/i,
      /(grassroots|activism|advocate|disproportionate|underserved|community-led)/i,
    ],
  },
] as const

export type CategorySlug = (typeof CATEGORIES)[number]['slug']

export interface CategoryScore {
  slug: CategorySlug
  confidence: number
  reasons: string[]
}

// Category lookup helper
export function getCategoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug)
}

/**
 * Categorize an article based on title and summary using rule-based scoring
 */
export function categorizeArticle(article: ArticleLike): CategoryScore[] {
  const { title, summary } = article
  const text = `${title} ${summary || ''}`.toLowerCase()
  const scores: CategoryScore[] = []

  for (const category of CATEGORIES) {
    let confidence = 0
    const reasons: string[] = []

    // Check keywords (weight: 0.3 per match, max 0.9)
    let keywordMatches = 0
    for (const keyword of category.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        keywordMatches++
        reasons.push(`keyword: ${keyword}`)
      }
    }
    const keywordScore = Math.min(keywordMatches * 0.3, 0.9)
    confidence += keywordScore

    // Check patterns (weight: 0.4 per match, max 1.2)
    let patternMatches = 0
    for (const pattern of category.patterns) {
      if (pattern.test(text)) {
        patternMatches++
        reasons.push(`pattern: ${pattern.source}`)
      }
    }
    const patternScore = Math.min(patternMatches * 0.4, 1.2)
    confidence += patternScore

    // Only include categories with meaningful confidence
    if (confidence >= 0.3) {
      scores.push({
        slug: category.slug,
        confidence: Math.min(confidence, 1.0), // Cap at 1.0
        reasons,
      })
    }
  }

  // Sort by confidence (highest first)
  return scores.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Tag an article with categories above confidence threshold
 */
export function tagArticle(
  article: ArticleLike,
  confidenceThreshold = 0.3
): CategoryScore[] {
  const scores = categorizeArticle(article)
  return scores.filter((score) => score.confidence >= confidenceThreshold)
}
