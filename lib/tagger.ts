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
    slug: 'justice',
    name: 'Activism',
    description:
      'Climate protests, rallies, strikes, and direct action by grassroots movements and activist organizations',
    color: '#EC4899', // pink
    keywords: [
      // Specific activist organizations
      'extinction rebellion',
      'fridays for future',
      'sunrise movement',
      'just stop oil',
      'greenpeace',
      '350.org',
      'climate defiance',

      // Direct action terms
      'protest',
      'protesters',
      'demonstration',
      'demonstrators',
      'march',
      'rally',
      'strike',
      'climate strike',
      'school strike',
      'sit-in',
      'blockade',
      'civil disobedience',
      'direct action',
      'arrested',
      'disrupt',
      'disruption',

      // Activist-specific terms
      'activist',
      'activists',
      'activism',
      'grassroots movement',
      'climate activist',
      'youth activist',

      // Specific movement actions
      'occupy',
      'encampment',
      'hunger strike',
      'tree sit',
    ],
    patterns: [
      /(protest|protesters?|demonstration|demonstrators?|march|rally|strike)/i,
      /(extinction rebellion|fridays for future|sunrise movement|just stop oil|greenpeace)/i,
      /(civil disobedience|direct action|blockade|sit-in|disrupt)/i,
      /(activists?|activism|grassroots movement|climate activist)/i,
      /(occupy|encampment|hunger strike|arrested.*protest)/i,
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
      'climate crisis',
      'climate refugee',
      'climate migration',
      'climate displacement',
      'displaced by climate',
    ],
    patterns: [
      /(hurricane|flood|drought|wildfire|heatwave|storm|tornado|cyclone)/i,
      /(sea level|glacier|ice sheet|arctic|coral|species|extinction)/i,
      /(ecosystem|biodiversity|agriculture|crops|water|food security)/i,
      /(climate (crisis|refugee|migration|displacement)|displaced by climate)/i,
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
    name: 'Research & Innovation',
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
 * Check if an article is climate-relevant by requiring at least one climate-related term.
 * This prevents non-climate political/business news from slipping through.
 *
 * TODO: This is prone to both false positives and false negatives. A simple way to improve this is to use LLMs to check the article + summary.
 */
export function isClimateRelevant(article: ArticleLike): boolean {
  const text = `${article.title} ${article.summary || ''}`.toLowerCase()

  const climateTerms = [
    // Core climate terms
    /\b(climate|carbon|emission|greenhouse|warming|global warming)\b/i,

    // Energy & renewables
    /\b(renewable|fossil|solar|wind|energy|hydroelectric|geothermal|biomass)\b/i,
    /\b(ev|evs|electric[- ]vehicles?|electric[- ]cars?|plug-in|battery[- ]electric|tesla)\b/i,
    /\b(battery|batteries|charging station|charging network|grid storage|long-duration storage)\b/i,
    /\b(hydrogen|ammonia|electrolyzer|fuel cell)\b/i,
    /\b(nuclear|reactor|reactors|fusion|fission|small modular reactor)\b/i,

    // Fossil fuels
    /\b(oil|gas|methane|petroleum|petrochemical|refinery|refineries|diesel|jet fuel|kerosene)\b/i,
    /\b(coal|mining|miners|mine|strip mine|mountaintop removal)\b/i,
    /\b(fracking|drilling|offshore rig|rigs|pipeline|pipelines|liquefied natural gas|lng)\b/i,

    // Weather & climate impacts
    /\b(flood|floods|flooding|flooded|floodwater|floodwaters)\b/i,
    /\b(drought|droughts|water shortage|water scarcity)\b/i,
    /\b(storm|storms|tropical storm|storm surge|hurricane|typhoon|cyclone|tornado|tornadoes)\b/i,
    /\b(atmospheric river|heavy rain|heavy rainfall|torrential rain|deluge)\b/i,
    /\b(wildfire|wildfires|fire danger|fire weather|smoke plume|smoke plumes|bushfire)\b/i,
    /\b(heat|heatwave|heat wave|heatwaves|heat waves|heat dome|heat domes|heat index|extreme heat|hot weather)\b/i,
    /\b(mudslide|mudslides|landslide|landslides|debris flow)\b/i,
    /\b(extreme weather|severe weather|climate crisis|climate emergency|climate disaster)\b/i,

    // Ecosystems & biodiversity
    /\b(sea[- ]?level|rising seas|coastal flooding|ocean warming|ocean acidification)\b/i,
    /\b(glacier|glaciers|ice sheet|ice sheets|arctic|antarctic|polar|permafrost|ice melt)\b/i,
    /\b(coral|coral reef|coral bleaching|marine life|ocean)\b/i,
    /\b(deforestation|forest|forests|rainforest|amazon|logging|trees|reforestation)\b/i,
    /\b(ecosystem|ecosystems|biodiversity|species extinction|habitat loss|endangered species)\b/i,
    /\b(agriculture|agricultural|crop|crops|farming|farmers|food security|food supply|harvest)\b/i,
    /\b(water crisis|water stress|precipitation|rainfall|snowpack)\b/i,
    /\b(colorado river|colorado river basin|river compact|water (?:allocation|allocations|allotment|sharing))\b/i,

    // Environmental & pollution
    /\b(environmental|environment|pollution|pollutants|air quality|water quality|soot|smog)\b/i,

    // Technology & innovation
    /\b(carbon capture|ccus|ccs|direct air capture|carbon removal|carbon sequestration)\b/i,
    /\b(clean energy|clean tech|cleantech|green tech|green energy)\b/i,
    /\b(smart grid|microgrid|transmission line|utility scale)\b/i,

    // Policy & regulation
    /\b(epa|environmental protection|ferc|sec.*climate|climate policy|climate law)\b/i,
    /\b(carbon tax|carbon pricing|emissions? standard|emissions? trading|cap and trade)\b/i,
    /\b(paris agreement|cop\d+|ipcc|unfccc|net zero|net-zero)\b/i,

    // Activism & organizations
    /\b(climate strike|climate protest|climate march|climate rally|climate activist)\b/i,
    /\b(extinction rebellion|fridays for future|sunrise movement|just stop oil)\b/i,
    /\b(greenpeace|sierra club|friends of the earth|350\.org|earthjustice)\b/i,
    /\b(world wildlife fund|wwf|union of concerned scientists)\b/i,

    // Finance & business
    /\b(esg.*climate|climate.*esg|green finance|climate finance|sustainable finance)\b/i,
    /\b(carbon credit|carbon market|carbon offset|climate risk)\b/i,
    /\b(divest.*fossil|stranded asset|climate disclosure)\b/i,
  ]

  return climateTerms.some((pattern) => pattern.test(text))
}

/**
 * Categorize an article based on title and summary using rule-based scoring
 */
export function categorizeArticle(article: ArticleLike): CategoryScore[] {
  // CRITICAL: First check if article is climate-relevant
  // This prevents non-climate articles from being categorized and appearing in the river
  if (!isClimateRelevant(article)) {
    console.log(
      `⚠️  Article filtered out (not climate-relevant): "${article.title.substring(0, 60)}..."`
    )
    return []
  }

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
