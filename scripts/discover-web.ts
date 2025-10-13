// scripts/discover-web.ts
import { query, endPool } from '@/lib/db'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { categorizeAndStoreArticle } from '@/lib/categorizer'

// Breaking news queries - optimized for frequent runs to catch urgent stories
const BREAKING_NEWS_QUERIES = [
  'climate emergency breaking news today',
  'extreme weather event happening now',
  'huge climate protest happening now',
  'climate policy announcement today',
  'wildfire flood hurricane current',
]

// Comprehensive search queries for daily deep discovery
const SEARCH_QUERIES = [
  // Breaking news & emergencies
  'climate emergency declaration 2025',
  'extreme weather event today breaking',
  'environmental disaster recent news',

  // Policy & regulation
  'climate policy announcement new legislation',
  'carbon tax regulation government decision',
  'renewable energy mandate policy',

  // Technology breakthroughs
  'carbon capture technology breakthrough',
  'renewable energy efficiency milestone',
  'battery storage innovation announcement',

  // Corporate & finance
  'climate investment funding announcement',
  'ESG sustainability corporate news',
  'green bond climate finance deal',

  // Science & research
  'climate study research paper findings',
  'IPCC climate report release',
  'temperature record climate data',

  // Lawsuits & legal
  'climate lawsuit verdict decision',
  'environmental court ruling',
  'fossil fuel legal action',
]

type WebSearchResult = {
  title: string
  url: string
  snippet: string
  publishedDate?: string
  source?: string
}

type WebBrowseStats = {
  estimatedCost: number
  toolCalls: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    promptTokens?: number
    completionTokens?: number
  }
}

type EnhancedSearchResult = {
  results: WebSearchResult[]
  browseStats: WebBrowseStats | null
}

const GOOGLE_SUGGESTION_MODEL =
  process.env.GOOGLE_SUGGESTION_MODEL || 'gpt-4o-mini'
const GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS = parseEnvInt(
  'GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS',
  600
)

const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== '0'
const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || 'gpt-4o'
const WEB_SEARCH_MAX_OUTPUT_TOKENS = parseEnvInt(
  'WEB_SEARCH_MAX_OUTPUT_TOKENS',
  600
)
const WEB_SEARCH_RESULT_LIMIT = parseEnvInt('WEB_SEARCH_LIMIT_PER_QUERY', 6)
const WEB_SEARCH_CONTEXT_SIZE = (() => {
  const raw = (process.env.WEB_SEARCH_CONTEXT_SIZE || 'medium').toLowerCase()
  return raw === 'low' || raw === 'high' ? raw : ('medium' as const)
})()
const WEB_SEARCH_ALLOWED_DOMAINS = process.env.WEB_SEARCH_ALLOWED_DOMAINS
  ? process.env.WEB_SEARCH_ALLOWED_DOMAINS.split(',')
      .map((domain) => domain.trim())
      .filter(Boolean)
  : undefined
const WEB_SEARCH_DEBUG = process.env.WEB_SEARCH_DEBUG === '1'

const OPENAI_WEB_SEARCH_INPUT_PER_M = 2.5
const OPENAI_WEB_SEARCH_OUTPUT_PER_M = 10
const OPENAI_WEB_SEARCH_TOOL_CALL_COST = 0.015

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

function estimateWebSearchCost(usage: any, toolCalls: number): number {
  if (!usage && !toolCalls) return 0

  const inputTokens =
    typeof usage?.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage?.promptTokens === 'number'
        ? usage.promptTokens
        : 0
  const outputTokens =
    typeof usage?.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage?.completionTokens === 'number'
        ? usage.completionTokens
        : 0

  const fallbackTokens =
    inputTokens === 0 &&
    outputTokens === 0 &&
    typeof usage?.totalTokens === 'number'
      ? usage.totalTokens
      : 0

  const costFromTokens =
    (inputTokens / 1_000_000) * OPENAI_WEB_SEARCH_INPUT_PER_M +
    (outputTokens / 1_000_000) * OPENAI_WEB_SEARCH_OUTPUT_PER_M +
    (fallbackTokens / 1_000_000) * OPENAI_WEB_SEARCH_INPUT_PER_M

  const totalCost =
    costFromTokens + toolCalls * OPENAI_WEB_SEARCH_TOOL_CALL_COST
  return Number.isFinite(totalCost) ? totalCost : 0
}

function dedupeWebResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>()
  return results.filter((result) => {
    const urlKey = result.url ? result.url.trim().toLowerCase() : ''
    const titleKey = result.title ? result.title.trim().toLowerCase() : ''
    const key = urlKey || titleKey
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseWebSearchJson(
  content: string | null | undefined,
  query: string
): WebSearchResult[] {
  if (!content) return []
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const results: WebSearchResult[] = []
    for (const item of parsed) {
      if (!item) continue
      const title =
        typeof item.title === 'string'
          ? item.title.trim()
          : typeof item.headline === 'string'
            ? item.headline.trim()
            : ''
      const url =
        typeof item.url === 'string'
          ? item.url.trim()
          : typeof item.link === 'string'
            ? item.link.trim()
            : ''
      if (!title || !url) continue

      const snippet =
        typeof item.snippet === 'string' && item.snippet.trim().length > 0
          ? item.snippet.trim()
          : typeof item.summary === 'string' && item.summary.trim().length > 0
            ? item.summary.trim()
            : typeof item.description === 'string' &&
                item.description.trim().length > 0
              ? item.description.trim()
              : `Latest climate coverage for "${query}"`

      const published =
        typeof item.publishedDate === 'string'
          ? item.publishedDate
          : typeof item.published_at === 'string'
            ? item.published_at
            : typeof item.date === 'string'
              ? item.date
              : undefined

      const source =
        typeof item.source === 'string' && item.source.trim().length > 0
          ? item.source.trim()
          : extractSourceFromUrl(url)

      results.push({
        title,
        url,
        snippet,
        publishedDate: published,
        source,
      })
    }

    return results
  } catch (error) {
    console.error('Error parsing web search JSON:', error)
    return []
  }
}

async function callOpenAIWebSearch(
  query: string
): Promise<{ results: WebSearchResult[]; stats: WebBrowseStats | null }> {
  if (!WEB_SEARCH_ENABLED) {
    return { results: [], stats: null }
  }

  try {
    console.log(`🔎 OpenAI web search: ${query}`)

    const toolArgs =
      WEB_SEARCH_ALLOWED_DOMAINS && WEB_SEARCH_ALLOWED_DOMAINS.length > 0
        ? { filters: { allowedDomains: WEB_SEARCH_ALLOWED_DOMAINS } }
        : {}

    const response = await generateText({
      model: openai(WEB_SEARCH_MODEL),
      messages: [
        {
          role: 'system',
          content: `You are a climate and environment news researcher. Use the web search tool to locate the most recent, high-quality coverage about the user's query. Return ONLY a JSON array where each item has: title, url, snippet, publishedDate (ISO if known), and source (publication name or domain). Do not include additional text outside the JSON.`,
        },
        {
          role: 'user',
          content: `Find up to ${WEB_SEARCH_RESULT_LIMIT} timely climate or environment-related articles for: "${query}". Favor reporting from reputable outlets within the past 72 hours.`,
        },
      ],
      tools: {
        webSearch: openai.tools.webSearch({
          searchContextSize: WEB_SEARCH_CONTEXT_SIZE,
          ...toolArgs,
        }),
      },
      toolChoice: 'auto',
      maxOutputTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
      providerOptions: {
        openai: {
          maxCompletionTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
        },
      },
    })

    let results = parseWebSearchJson(response.text, query)
    if (results.length === 0) {
      console.log(
        'Web search returned no structured results; attempting fallback parsing'
      )
      if (WEB_SEARCH_DEBUG && response.text) {
        console.log(
          'Web search response text preview:',
          response.text.substring(0, 200)
        )
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.toolResults) &&
        response.toolResults.length > 0
      ) {
        console.log(
          'Web search tool result sample:',
          JSON.stringify(response.toolResults[0] ?? null).substring(0, 200)
        )
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.toolCalls) &&
        response.toolCalls.length > 0
      ) {
        console.log(
          'Web search tool call sample:',
          JSON.stringify(response.toolCalls[0] ?? null).substring(0, 200)
        )
      }
      if (
        WEB_SEARCH_DEBUG &&
        Array.isArray(response.sources) &&
        response.sources.length > 0
      ) {
        console.log(
          'Web search source sample:',
          JSON.stringify(response.sources[0] ?? null).substring(0, 200)
        )
      }
      const fallback = parseContentForArticles(response.text || '')
      if (fallback.length > 0) {
        console.log('Falling back to parsed content for web search results')
        results = fallback
      }
    }

    results = dedupeWebResults(results).slice(0, WEB_SEARCH_RESULT_LIMIT)

    const toolCalls =
      Array.isArray(response.toolResults) && response.toolResults.length > 0
        ? response.toolResults.length
        : Array.isArray(response.toolCalls)
          ? response.toolCalls.length
          : 0
    const usage = response.totalUsage || response.usage
    const estimatedCost = estimateWebSearchCost(usage, toolCalls)

    if (estimatedCost > 0) {
      console.log(
        `OpenAI web search returned ${results.length} results (~$${estimatedCost.toFixed(4)})`
      )
    } else {
      console.log(`OpenAI web search returned ${results.length} results`)
    }

    return {
      results,
      stats: {
        estimatedCost,
        toolCalls,
        usage,
      },
    }
  } catch (error) {
    console.error('Error calling OpenAI web search:', error)
    return { results: [], stats: { estimatedCost: 0, toolCalls: 0 } }
  }
}

async function generateGoogleNewsSuggestions(
  query: string
): Promise<string | null> {
  console.log(`OpenAI Google News suggestions: ${query}`)

  try {
    const { text } = await generateText({
      model: openai(GOOGLE_SUGGESTION_MODEL),
      messages: [
        {
          role: 'system',
          content: `You are assisting with building Google News RSS queries for climate reporting. Return only a JSON array. Each element must contain "searchTerm" (string suitable for Google News), "reasoning" (short justification), and "expectedSources" (array of publication names). Do not include any additional prose outside the JSON.`,
        },
        {
          role: 'user',
          content: `Provide 2-4 optimized Google News search phrases to surface fresh climate or environment coverage for: "${query}". Prioritize the past 48 hours.`,
        },
      ],
      maxOutputTokens: GOOGLE_SUGGESTION_MAX_OUTPUT_TOKENS,
    })

    return text ?? null
  } catch (error) {
    console.error('Error generating Google News suggestions:', error)
    return null
  }
}

async function discoverViaGoogleNews(
  query: string
): Promise<WebSearchResult[]> {
  const suggestionText = await generateGoogleNewsSuggestions(query)
  const suggestionResults = await executeAISearchSuggestions(suggestionText)

  if (suggestionResults.length > 0) {
    return suggestionResults
  }

  console.log('AI suggestions empty, falling back to direct Google News search')
  return await searchGoogleNewsRSS(query)
}

async function callOpenAIEnhancedSearch(
  query: string
): Promise<EnhancedSearchResult> {
  const combined: WebSearchResult[] = []
  let browseStats: WebBrowseStats | null = null

  const webSearch = await callOpenAIWebSearch(query)
  if (webSearch.results.length > 0) {
    combined.push(...webSearch.results)
  }
  if (webSearch.stats) {
    browseStats = webSearch.stats
  }

  const googleResults = await discoverViaGoogleNews(query)
  if (googleResults.length > 0) {
    combined.push(...googleResults)
  }

  return {
    results: dedupeWebResults(combined),
    browseStats,
  }
}

async function executeAISearchSuggestions(
  content: string | null | undefined
): Promise<WebSearchResult[]> {
  if (!content) {
    return []
  }

  try {
    const suggestions = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.log('No JSON array found in AI response')
      return []
    }

    console.log(`AI suggested ${suggestions.length} search terms`)

    const allResults: WebSearchResult[] = []

    for (const suggestion of suggestions.slice(0, 3)) {
      // Limit to 3 suggestions
      const searchTerm = suggestion.searchTerm || suggestion.search_term
      if (!searchTerm) continue

      console.log(`Executing AI suggestion: "${searchTerm}"`)
      const results = await searchGoogleNewsRSS(searchTerm)
      allResults.push(...results)

      // Small delay between searches
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    return allResults
  } catch (error) {
    console.error('Error executing AI search suggestions:', error)
    return []
  }
}

async function searchGoogleNewsRSS(query: string): Promise<WebSearchResult[]> {
  // Import RSS parser
  const Parser = (await import('rss-parser')).default
  const parser = new Parser({
    headers: {
      'User-Agent': 'ClimateRiverBot/0.1 (+https://climateriver.org)',
    },
    requestOptions: { timeout: 10000 },
  })

  try {
    // Google News RSS search URL
    const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`

    const feed = await parser.parseURL(searchUrl)

    const results: WebSearchResult[] = []
    const items = (feed.items || []).slice(0, 5) // Limit to 5 results per query

    for (const item of items) {
      if (!item.title || !item.link) continue

      // Extract the real URL from Google News redirect
      const realUrl = extractRealUrl(item.link)

      results.push({
        title: cleanGoogleNewsTitle(item.title),
        url: realUrl,
        snippet: item.contentSnippet || item.content || '',
        publishedDate: item.isoDate || item.pubDate,
        source: extractSourceFromUrl(realUrl),
      })
    }

    return results
  } catch (error) {
    console.error(`Error searching Google News for "${query}":`, error)
    return []
  }
}

function extractRealUrl(googleUrl: string): string {
  try {
    // Google News URLs are often redirects, try to extract the real URL
    const url = new URL(googleUrl)

    // If it's a Google News URL, try to extract the real URL from the path
    if (url.hostname.includes('news.google.com')) {
      // This is a simplified extraction - in practice you might need more robust parsing
      const pathParts = url.pathname.split('/')
      const articlePart = pathParts.find((part) => part.includes('http'))
      if (articlePart) {
        return decodeURIComponent(articlePart)
      }
    }

    return googleUrl
  } catch {
    return googleUrl
  }
}

function cleanGoogleNewsTitle(title: string): string {
  // Remove trailing " - Source Name" from Google News titles
  return title.replace(/\s-\s[^-]+$/, '').trim()
}

function extractResponsesAPIResults(
  openaiResponse: any,
  query: string
): WebSearchResult[] {
  try {
    // Parse the Responses API format - it has different possible fields
    let content = ''

    if (openaiResponse.text) {
      content = openaiResponse.text
    } else if (openaiResponse.output && Array.isArray(openaiResponse.output)) {
      // Output is an array of objects, combine their text content
      console.log('Output array length:', openaiResponse.output.length)
      console.log(
        'First output item keys:',
        openaiResponse.output[0]
          ? Object.keys(openaiResponse.output[0])
          : 'none'
      )

      content = openaiResponse.output
        .map((item: any) => {
          if (typeof item === 'string') return item
          if (item.text) return item.text
          if (item.content) return item.content
          if (item.value) return item.value
          return JSON.stringify(item)
        })
        .join('\n')
    } else if (
      openaiResponse.output &&
      typeof openaiResponse.output === 'string'
    ) {
      content = openaiResponse.output
    } else {
      console.log('No usable content found in response')
      console.log('Available fields:', Object.keys(openaiResponse))
      console.log('Output type:', typeof openaiResponse.output)
      console.log('Text type:', typeof openaiResponse.text)
      return []
    }

    console.log('Content preview:', String(content).substring(0, 300))

    // Ensure content is a string
    const contentStr = String(content)

    if (!contentStr || contentStr.length < 20) {
      console.log('Content too short, no articles found')
      return []
    }

    // Extract articles from the structured output
    const results = parseContentForArticles(contentStr)

    console.log(`Found ${results.length} articles from OpenAI web search`)
    if (results.length > 0) {
      console.log('First result:', results[0])
    }

    return results
  } catch (error) {
    console.error('Error parsing Responses API results:', error)
    return []
  }
}

function extractWebSearchResults(openaiResponse: any): WebSearchResult[] {
  try {
    const message = openaiResponse.choices?.[0]?.message
    const toolCalls = message?.tool_calls || []

    const results: WebSearchResult[] = []

    // Look for web search tool calls and extract results
    for (const toolCall of toolCalls) {
      if (toolCall.type === 'web_search') {
        const searchResults = toolCall.web_search?.results || []

        for (const result of searchResults) {
          if (result.url && result.title) {
            results.push({
              title: result.title,
              url: result.url,
              snippet: result.snippet || result.content || '',
              publishedDate: result.published_date || result.date,
              source: extractSourceFromUrl(result.url),
            })
          }
        }
      }
    }

    // If no tool calls with results, try to parse from the response content
    if (results.length === 0 && message?.content) {
      const fallbackResults = parseContentForArticles(message.content)
      results.push(...fallbackResults)
    }

    return results
  } catch (error) {
    console.error('Error parsing web search results:', error)
    return []
  }
}

function parseContentForArticles(content: string): WebSearchResult[] {
  const results: WebSearchResult[] = []

  // Look for URLs in the content
  const urlRegex = /https?:\/\/[^\s\)\]]+/g
  const urls = content.match(urlRegex) || []

  // Split content into meaningful chunks
  const lines = content.split('\n').filter((line) => line.trim())

  // Look for various patterns that indicate articles
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Skip headers and meta information
    if (
      line.startsWith('#') ||
      line.toLowerCase().includes('found') ||
      line.toLowerCase().includes('search')
    ) {
      continue
    }

    // Pattern 1: "Title - Source" format
    let titleSourceMatch = line.match(/^[\d\.\s]*(.+?)\s*[-–]\s*(.+)$/)

    // Pattern 2: "Title (Source)" format
    if (!titleSourceMatch) {
      titleSourceMatch = line.match(/^[\d\.\s]*(.+?)\s*\((.+?)\)\s*$/)
    }

    // Pattern 3: Look for lines that might be titles followed by URLs
    if (!titleSourceMatch && line.length > 20 && !line.includes('http')) {
      // Check if next lines contain URLs
      const nextLines = lines.slice(i + 1, i + 3)
      const nextUrl = nextLines.find((l) => l.includes('http'))

      if (nextUrl) {
        const urlMatch = nextUrl.match(/https?:\/\/[^\s\)\]]+/)
        if (urlMatch) {
          const potentialTitle = line.replace(/^[\d\.\s]*/, '').trim()
          // Validate that title doesn't look like raw JSON (be specific to avoid false positives)
          const looksLikeJson = /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(potentialTitle) || 
                                potentialTitle.includes('": "') ||
                                (potentialTitle.startsWith('{') && potentialTitle.includes(':'))
          
          if (!looksLikeJson) {
            results.push({
              title: potentialTitle,
              url: urlMatch[0],
              snippet:
                nextLines.find((l) => !l.includes('http') && l.length > 10) ||
                'Climate news article',
              source: extractSourceFromUrl(urlMatch[0]),
              publishedDate: new Date().toISOString(),
            })
          }
        }
      }
    }

    if (titleSourceMatch && titleSourceMatch[1] && titleSourceMatch[2]) {
      const title = titleSourceMatch[1].trim()
      let source = titleSourceMatch[2].trim()

      // Clean up the source (remove dates, extra info)
      source = source.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/, '').trim()
      source = source.replace(/^\s*-\s*/, '').trim()

      // Find corresponding URL
      let correspondingUrl = urls.find((url) => {
        const hostname = extractSourceFromUrl(url).toLowerCase()
        const sourceWords = source.toLowerCase().split(' ')
        return sourceWords.some(
          (word) => word.length > 3 && hostname.includes(word)
        )
      })

      // Fallback: use any available URL
      if (!correspondingUrl && urls.length > results.length) {
        correspondingUrl = urls[results.length]
      }

      // Validate that title doesn't look like raw JSON (be specific to avoid false positives)
      const looksLikeJson = /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(title) || 
                            title.includes('": "') ||
                            (title.startsWith('{') && title.includes(':'))
      
      if (correspondingUrl && title.length > 10 && !looksLikeJson) {
        results.push({
          title: title,
          url: correspondingUrl,
          snippet: `Recent coverage: ${title.substring(0, 100)}...`,
          source: source,
          publishedDate: new Date().toISOString(),
        })
      }
    }
  }

  // Deduplicate by URL
  const seen = new Set()
  return results.filter((result) => {
    if (seen.has(result.url)) return false
    seen.add(result.url)
    return true
  })
}

function extractSourceFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return hostname
  } catch {
    return 'Unknown'
  }
}

async function isDuplicate(title: string, url: string): Promise<boolean> {
  // Check if we already have this article by URL
  const existingByUrl = await query(
    'SELECT id FROM articles WHERE canonical_url = $1',
    [url]
  )

  if (existingByUrl.rows.length > 0) {
    return true
  }

  // Check for similar title (basic duplicate detection)
  const titleWords = title
    .toLowerCase()
    .split(' ')
    .filter((w) => w.length > 3)
  const titlePattern = titleWords.slice(0, 5).join('|') // First 5 significant words

  if (titlePattern) {
    const existingByTitle = await query(
      "SELECT id FROM articles WHERE LOWER(title) ~ $1 AND fetched_at > NOW() - INTERVAL '7 days'",
      [titlePattern]
    )

    if (existingByTitle.rows.length > 0) {
      return true
    }
  }

  return false
}

async function insertWebDiscoveredArticle(
  result: WebSearchResult,
  sourceId: number
): Promise<number | null> {
  try {
    const { rows } = await query<{ id: number }>(
      `
      INSERT INTO articles (
        source_id, 
        title, 
        canonical_url, 
        dek,
        published_at,
        fetched_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id
    `,
      [
        sourceId,
        result.title,
        result.url,
        result.snippet,
        result.publishedDate ? new Date(result.publishedDate) : new Date(),
      ]
    )

    return rows[0]?.id || null
  } catch (error) {
    console.error('Error inserting web discovered article:', error)
    return null
  }
}

async function getOrCreateWebDiscoverySource(): Promise<number> {
  // Check if we have a "Web Discovery" source
  const existing = await query('SELECT id FROM sources WHERE slug = $1', [
    'web-discovery',
  ])

  if (existing.rows.length > 0) {
    return existing.rows[0].id
  }

  // Create the web discovery source
  const { rows } = await query<{ id: number }>(
    `
    INSERT INTO sources (name, homepage_url, feed_url, weight, slug)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `,
    [
      'Web Discovery',
      'https://climateriver.org',
      'web-discovery://openai',
      4.0, // High weight for curated discoveries
      'web-discovery',
    ]
  )

  return rows[0].id
}

async function ensureClusterForArticle(articleId: number, title: string) {
  // Simple clustering based on title keywords (reuse your existing logic)
  const titleWords = title.toLowerCase().split(' ')
  const keywords = titleWords.filter((w) => w.length > 4).slice(0, 3)
  const clusterKey = keywords.join('-') || `article-${articleId}`

  // Get or create cluster
  const { rows: clusters } = await query<{ id: number }>(
    `
    INSERT INTO clusters (key, created_at)
    VALUES ($1, NOW())
    ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
    RETURNING id
  `,
    [clusterKey]
  )

  const clusterId = clusters[0].id

  // Link article to cluster
  await query(
    `
    INSERT INTO article_clusters (article_id, cluster_id)
    VALUES ($1, $2)
    ON CONFLICT (article_id, cluster_id) DO NOTHING
  `,
    [articleId, clusterId]
  )
}

export async function run(
  opts: {
    limitPerQuery?: number
    maxQueries?: number
    breakingNewsMode?: boolean
    closePool?: boolean
  } = {}
) {
  const startTime = Date.now()
  const limitPerQuery = opts.limitPerQuery || 3 // Increased defaults
  const maxQueries = opts.maxQueries || 5 // Increased defaults
  const breakingNewsMode = opts.breakingNewsMode || false

  // Updated limits for better coverage
  const maxTotalArticles = breakingNewsMode ? 10 : 40

  // Select appropriate query set
  const querySet = breakingNewsMode ? BREAKING_NEWS_QUERIES : SEARCH_QUERIES
  const mode = breakingNewsMode ? 'breaking news' : 'comprehensive'

  console.log(`Starting ${mode} web discovery with ${maxQueries} queries...`)

  const sourceId = await getOrCreateWebDiscoverySource()
  let totalInserted = 0
  let totalScanned = 0
  let totalBrowseCost = 0
  let totalBrowseToolCalls = 0

  const selectedQueries = querySet.slice(0, maxQueries)

  for (const query of selectedQueries) {
    console.log(`Searching: ${query}`)

    const { results, browseStats } = await callOpenAIEnhancedSearch(query)
    if (browseStats) {
      totalBrowseCost += browseStats.estimatedCost
      totalBrowseToolCalls += browseStats.toolCalls
    }

    totalScanned += results.length

    let inserted = 0

    for (const result of results.slice(0, limitPerQuery)) {
      // Hard stop if we've hit our total article limit
      if (totalInserted >= maxTotalArticles) {
        console.log(
          `🛑 Hit max article limit (${maxTotalArticles}), stopping discovery`
        )
        break
      }

      const duplicate = await isDuplicate(result.title, result.url)

      if (!duplicate) {
        const articleId = await insertWebDiscoveredArticle(result, sourceId)

        if (articleId) {
          await ensureClusterForArticle(articleId, result.title)

          // Categorize the article using hybrid approach
          try {
            await categorizeAndStoreArticle(
              articleId,
              result.title,
              result.snippet || undefined
            )
            console.log(
              `✓ Added & categorized: ${result.title.substring(0, 60)}...`
            )
          } catch (error) {
            console.error(
              `  ❌ Failed to categorize article ${articleId}:`,
              error
            )
            console.log(
              `✓ Added (uncategorized): ${result.title.substring(0, 60)}...`
            )
          }

          inserted++
          totalInserted++
        }
      } else {
        console.log(`- Skipped duplicate: ${result.title.substring(0, 60)}...`)
      }
    }

    // Stop outer loop if we hit the limit
    if (totalInserted >= maxTotalArticles) {
      console.log(
        `🛑 Reached total article limit (${maxTotalArticles}), ending discovery`
      )
      break
    }

    console.log(`Query "${query}": ${inserted} new articles`)

    // Small delay between queries to be respectful
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  const duration = Math.round((Date.now() - startTime) / 1000)
  console.log(
    `Web discovery completed: ${totalInserted} new articles from ${totalScanned} results in ${duration}s`
  )

  if (totalBrowseCost > 0) {
    console.log(
      `Estimated OpenAI web search spend: ~$${totalBrowseCost.toFixed(
        4
      )} (${totalBrowseToolCalls} tool calls)`
    )
  }

  if (opts.closePool) {
    await endPool()
  }

  return {
    totalInserted,
    totalScanned,
    duration,
    queriesRun: selectedQueries.length,
    estimatedBrowseCost: totalBrowseCost,
    browseToolCalls: totalBrowseToolCalls,
  }
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
