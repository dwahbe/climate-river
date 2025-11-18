// scripts/discover-web.ts
import { query, endPool } from '@/lib/db'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { categorizeAndStoreArticle } from '@/lib/categorizer'
import { isClimateRelevant } from '@/lib/tagger'
import { Buffer } from 'node:buffer'
import {
  CURATED_CLIMATE_OUTLETS,
  type ClimateOutlet,
} from '@/config/climateOutlets'

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

type WebSearchOverrides = {
  systemPrompt?: string
  userPrompt?: string
  resultLimit?: number
  allowedDomains?: string[]
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
const DISCOVERY_PAUSE_MS = 2000
const DEFAULT_OUTLET_FRESHNESS_HOURS = 96
const HOST_BLOCKLIST = new Set([
  'news.google.com',
  'www.news.google.com',
  'news.yahoo.com',
  'www.news.yahoo.com',
  'msn.com',
  'www.msn.com',
])

const APOLOGY_PATTERNS = [
  /i['’]m sorry/i,
  /\bunable to (?:locate|find|retrieve)/i,
  /\bi (?:cannot|can't) (?:find|locate)/i,
  /\bas an ai\b/i,
  /\bno relevant results\b/i,
]

const sourceCache = new Map<string, number>()

const OUTLET_BATCH_DOMAIN_GROUPS: string[][] = [
  ['nytimes.com', 'washingtonpost.com', 'theguardian.com', 'apnews.com'],
  ['reuters.com', 'bloomberg.com', 'ft.com', 'politico.com'],
  [
    'insideclimatenews.org',
    'climatechangenews.com',
    'carbonbrief.org',
    'canarymedia.com',
    'heatmap.news',
  ],
  ['nationalgeographic.com', 'scientificamerican.com', 'nature.com', 'vox.com'],
  ['restofworld.org', 'mongabay.com', 'downtoearth.org.in', 'grist.org'],
  ['eenews.net', 'wri.org', 'iea.org', 'weforum.org'],
  ['amnesty.org', 'news.un.org', 'climate.gov', 'earthobservatory.nasa.gov'],
  ['carbon-pulse.com', 'ember-climate.org', 'energymonitor.ai', 'rmi.org'],
  [
    'project-syndicate.org',
    'theatlantic.com',
    'bbc.com',
    'nationalgeographic.com',
  ],
]

const GOOGLE_SUGGESTION_OUTLET_EXAMPLES = CURATED_CLIMATE_OUTLETS.slice(0, 10)
  .map((outlet) => outlet.name)
  .join(', ')

const OPENAI_WEB_SEARCH_INPUT_PER_M = 2.5
const OPENAI_WEB_SEARCH_OUTPUT_PER_M = 10
const OPENAI_WEB_SEARCH_TOOL_CALL_COST = 0.015

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

function estimateWebSearchCost(
  usage: WebBrowseStats['usage'] | null | undefined,
  toolCalls: number
): number {
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

function slugifyHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function humanizeHost(host: string): string {
  return host
    .split('.')
    .filter(
      (segment, idx, arr) =>
        idx === 0 || idx === arr.length - 1 || arr.length <= 2
    )
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function normalizeDomain(domain: string): string {
  return domain
    .replace(/^www\./, '')
    .trim()
    .toLowerCase()
}

function domainMatches(host: string, normalizedDomain: string): boolean {
  if (!host || !normalizedDomain) return false
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`)
}

function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (!url || allowedDomains.length === 0) return false
  const host = hostFromUrl(url)
  if (!host) return false
  const normalizedHost = normalizeDomain(host)
  return allowedDomains.some((domain) =>
    domainMatches(normalizedHost, normalizeDomain(domain))
  )
}

function looksLikeApologyResult(result: WebSearchResult): boolean {
  const haystack = `${result.title ?? ''} ${result.snippet ?? ''}`
    .toLowerCase()
    .trim()
  if (!haystack) return false
  return APOLOGY_PATTERNS.some((pattern) => pattern.test(haystack))
}

function updateDomainHitCounts(
  hitCounts: Map<string, number>,
  results: WebSearchResult[],
  normalizedDomains: string[]
) {
  if (normalizedDomains.length === 0) {
    return
  }

  for (const result of results) {
    const host = hostFromUrl(result.url)
    if (!host) continue
    const normalizedHost = normalizeDomain(host)
    for (const normalizedDomain of normalizedDomains) {
      if (domainMatches(normalizedHost, normalizedDomain)) {
        hitCounts.set(
          normalizedDomain,
          (hitCounts.get(normalizedDomain) ?? 0) + 1
        )
        break
      }
    }
  }
}

function extractJsonArrayBlock(content: string): string | null {
  if (!content) return null

  const fenced = content.match(/```json([\s\S]*?)```/i)
  if (fenced && fenced[1]) {
    return fenced[1].replace(/^\s+/, '').replace(/\s+$/, '')
  }

  const inline = content.match(/\[[\s\S]*\]/)
  return inline ? inline[0] : null
}

function cleanText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/`/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1') // markdown links
    .replace(/<[^>]+>/g, '')
    .trim()
}

function parseWebSearchJson(
  content: string | null | undefined,
  query: string
): WebSearchResult[] {
  const jsonBlock = extractJsonArrayBlock(content ?? '')
  if (!jsonBlock) return []

  try {
    const parsed = JSON.parse(jsonBlock)
    if (!Array.isArray(parsed)) return []

    const results: WebSearchResult[] = []
    for (const item of parsed) {
      if (!item) continue
      const title =
        typeof item.title === 'string'
          ? cleanText(item.title)
          : typeof item.headline === 'string'
            ? cleanText(item.headline)
            : ''
      const url =
        typeof item.url === 'string'
          ? item.url.trim()
          : typeof item.link === 'string'
            ? item.link.trim()
            : ''
      if (!title || !url) continue

      const snippet =
        cleanText(
          typeof item.snippet === 'string' && item.snippet.trim().length > 0
            ? item.snippet
            : typeof item.summary === 'string' && item.summary.trim().length > 0
              ? item.summary
              : typeof item.description === 'string' &&
                  item.description.trim().length > 0
                ? item.description
                : ''
        ) || `Latest coverage for "${query}"`

      const published =
        typeof item.publishedDate === 'string'
          ? item.publishedDate
          : typeof item.published_at === 'string'
            ? item.published_at
            : typeof item.date === 'string'
              ? item.date
              : undefined

      let source =
        typeof item.source === 'string' && item.source.trim().length > 0
          ? cleanText(item.source)
          : ''
      if (!source) {
        source = extractSourceFromUrl(url)
      }

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
  query: string,
  overrides?: WebSearchOverrides
): Promise<{ results: WebSearchResult[]; stats: WebBrowseStats | null }> {
  if (!WEB_SEARCH_ENABLED) {
    return { results: [], stats: null }
  }

  try {
    console.log(`🔎 OpenAI web search: ${query}`)

    const requestedLimit = overrides?.resultLimit ?? WEB_SEARCH_RESULT_LIMIT
    const systemMessage =
      overrides?.systemPrompt ??
      `You are ClimateRiver's climate desk scout. Before responding you must call openai.tools.webSearch with focused, site-specific queries (use site:domain, topic keywords, geography filters) while keeping tool calls to the minimum needed for full coverage. Only surface original journalism published within the past 72 hours from reputable climate or energy outlets. Reject syndicated copies, press releases, newsletters, video transcripts, or aggregator redirects (Google News, Yahoo, MSN). Verify that every URL's hostname matches any allowedDomains list provided and drop items without a verifiable timestamp. Respond ONLY with a JSON array sorted newest to oldest, where each item has title, url, snippet (climate angle), publishedDate in ISO 8601, and source (short outlet name). No prose outside the JSON.`
    const userMessage =
      overrides?.userPrompt ??
      `Find up to ${requestedLimit} vetted climate or environment-related articles for: "${query}". Require publish dates within the past 72 hours, prioritize investigative/policy/science/finance impact, and ensure each entry includes a trustworthy ISO timestamp. If fewer than ${requestedLimit} items qualify, only return the smaller set. Sort newest to oldest before responding.`
    const allowedDomains =
      overrides?.allowedDomains && overrides.allowedDomains.length > 0
        ? overrides.allowedDomains
        : WEB_SEARCH_ALLOWED_DOMAINS

    const toolArgs =
      allowedDomains && allowedDomains.length > 0
        ? { filters: { allowedDomains } }
        : {}

    const response = await generateText({
      model: openai(WEB_SEARCH_MODEL),
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content: userMessage,
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
      let toolDerived: WebSearchResult[] = []
      if (response.toolResults) {
        toolDerived = extractArticlesFromToolResults(
          response.toolResults,
          query
        )
      }
      if (toolDerived.length === 0 && response.toolCalls) {
        toolDerived = extractArticlesFromToolResults(response.toolCalls, query)
      }
      if (toolDerived.length > 0) {
        console.log(
          `Recovered ${toolDerived.length} articles from tool outputs fallback`
        )
        results = toolDerived
      } else {
        const sourceDerived = extractArticlesFromSources(
          response.sources,
          query
        )
        if (sourceDerived.length > 0) {
          console.log(
            `Recovered ${sourceDerived.length} articles from source metadata fallback`
          )
          results = sourceDerived
        } else {
          const fallback = parseContentForArticles(response.text || '')
          if (fallback.length > 0) {
            console.log('Falling back to parsed content for web search results')
            results = fallback
          }
        }
      }
    }

    results = dedupeWebResults(results)

    if (allowedDomains && allowedDomains.length > 0) {
      const before = results.length
      results = results.filter((result) =>
        isAllowedDomain(result.url, allowedDomains)
      )
      if (WEB_SEARCH_DEBUG && before !== results.length) {
        console.log(
          `Dropped ${before - results.length} results outside allowed domains`
        )
      }
    }

    const beforeApologyFilter = results.length
    results = results.filter((result) => !looksLikeApologyResult(result))
    if (WEB_SEARCH_DEBUG && beforeApologyFilter !== results.length) {
      console.log(
        `Dropped ${beforeApologyFilter - results.length} apology-style results`
      )
    }

    results = results.slice(0, requestedLimit)

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

async function callOpenAIEnhancedSearch(
  query: string,
  overrides?: WebSearchOverrides
): Promise<EnhancedSearchResult> {
  const combined: WebSearchResult[] = []
  let browseStats: WebBrowseStats | null = null

  const webSearch = await callOpenAIWebSearch(query, overrides)
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
          content: `You build advanced Google News RSS queries for climate reporting. Return only a JSON array. Each element must contain "searchTerm" (Google News-ready string), "reasoning" (short justification), and "expectedSources" (array). Every searchTerm must use boolean operators and/or quoted phrases, include a recency constraint such as when:1d/when:3d, and when helpful reference curated climate outlets (e.g., ${GOOGLE_SUGGESTION_OUTLET_EXAMPLES}) via site:domain or source keywords. Avoid generic requests like "climate change news". No prose outside the JSON.`,
        },
        {
          role: 'user',
          content: `Provide 2-4 advanced Google News search strings to surface fresh climate or environment coverage for: "${query}". Combine climate subtopics (policy, finance, science, justice) with geography or sector cues, apply recency filters (e.g., when:1d), and bias toward reputable climate outlets. Avoid generic or repetitive phrases.`,
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

const GOOGLE_TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ved',
  'usg',
  'oc',
  'si',
  'gclid',
  'fbclid',
])

function extractRealUrl(googleUrl: string): string {
  try {
    const url = new URL(googleUrl)
    if (!url.hostname.includes('news.google.com')) {
      return googleUrl
    }

    const candidateSegments = [
      url.searchParams.get('url'),
      url.searchParams.get('q'),
      url.searchParams.get('u'),
    ].filter((segment): segment is string => Boolean(segment))

    const pathSegments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })

    for (const candidate of [...candidateSegments, ...pathSegments]) {
      const resolved = resolveGoogleNewsCandidate(candidate)
      if (resolved) {
        return resolved
      }
    }

    return googleUrl
  } catch {
    return googleUrl
  }
}

function resolveGoogleNewsCandidate(
  candidate: string | undefined
): string | null {
  if (!candidate) return null
  const trimmed = candidate.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('http')) {
    return stripTrackingParams(trimmed)
  }

  const decoded = maybeDecodeBase64Url(trimmed)
  if (decoded?.startsWith('http')) {
    return stripTrackingParams(decoded)
  }

  return null
}

function maybeDecodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return null
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4
  const padded = normalized + '='.repeat((4 - padding) % 4)

  try {
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

function stripTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    for (const param of GOOGLE_TRACKING_PARAMS) {
      parsed.searchParams.delete(param)
    }
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return rawUrl
  }
}

function normalizePublishedDate(
  value: string | Date | null | undefined
): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isResultFresh(result: WebSearchResult, cutoffMs: number): boolean {
  const publishedAt = normalizePublishedDate(result.publishedDate)
  if (!publishedAt) {
    return false
  }
  return publishedAt.getTime() >= cutoffMs
}

function cleanGoogleNewsTitle(title: string): string {
  // Remove trailing " - Source Name" from Google News titles
  return title.replace(/\s-\s[^-]+$/, '').trim()
}

function parseContentForArticles(content: string): WebSearchResult[] {
  const results: WebSearchResult[] = []

  // Look for URLs in the content
  const urlRegex = /https?:\/\/[^\s)\]]+/g
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
    let titleSourceMatch = line.match(/^[\d.\s]*(.+?)\s*[-–]\s*(.+)$/)

    // Pattern 2: "Title (Source)" format
    if (!titleSourceMatch) {
      titleSourceMatch = line.match(/^[\d.\s]*(.+?)\s*\((.+?)\)\s*$/)
    }

    // Pattern 3: Look for lines that might be titles followed by URLs
    if (!titleSourceMatch && line.length > 20 && !line.includes('http')) {
      // Check if next lines contain URLs
      const nextLines = lines.slice(i + 1, i + 3)
      const nextUrl = nextLines.find((l) => l.includes('http'))

      if (nextUrl) {
        const urlMatch = nextUrl.match(/https?:\/\/[^\s)\]]+/)
        if (urlMatch) {
          const potentialTitle = line.replace(/^[\d.\s]*/, '').trim()
          // Validate that title doesn't look like raw JSON (be specific to avoid false positives)
          const looksLikeJson =
            /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(
              potentialTitle
            ) ||
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
      const looksLikeJson =
        /^["'](title|url|publishedDate|headline|link|description|snippet)["']\s*:/.test(
          title
        ) ||
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

function parseUnknownContentForArticles(
  content: unknown,
  query: string
): WebSearchResult[] {
  if (content == null) {
    return []
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    const structured = parseWebSearchJson(content, query)
    if (structured.length > 0) {
      return structured
    }
    return parseContentForArticles(content)
  }

  try {
    const serialized = JSON.stringify(content)
    if (serialized && serialized.length > 2) {
      const structured = parseWebSearchJson(serialized, query)
      if (structured.length > 0) {
        return structured
      }
      return parseContentForArticles(serialized)
    }
  } catch (error) {
    if (WEB_SEARCH_DEBUG) {
      console.log('Unable to stringify tool result output:', error)
    }
  }

  return []
}

function extractArticlesFromToolResults(
  toolResults: unknown,
  query: string
): WebSearchResult[] {
  if (!Array.isArray(toolResults)) {
    return []
  }

  const aggregated: WebSearchResult[] = []

  for (const toolResult of toolResults) {
    if (!toolResult || typeof toolResult !== 'object') continue

    const toolName =
      typeof (toolResult as { toolName?: unknown }).toolName === 'string'
        ? ((toolResult as { toolName?: string }).toolName ?? '')
        : ''

    if (
      toolName &&
      toolName !== 'web_search' &&
      toolName !== 'webSearch' &&
      toolName !== 'web_search_preview'
    ) {
      continue
    }

    const payloads = [
      (toolResult as { output?: unknown }).output,
      (toolResult as { result?: unknown }).result,
      (toolResult as { data?: unknown }).data,
    ]

    for (const payload of payloads) {
      const parsed = parseUnknownContentForArticles(payload, query)
      if (parsed.length > 0) {
        aggregated.push(...parsed)
        break
      }
    }
  }

  return aggregated
}

function extractArticlesFromSources(
  sources: unknown,
  query: string
): WebSearchResult[] {
  if (!Array.isArray(sources)) {
    return []
  }

  const results: WebSearchResult[] = []

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue

    const sourceType =
      typeof (source as { sourceType?: unknown }).sourceType === 'string'
        ? ((source as { sourceType?: string }).sourceType ?? '')
        : ''

    if (sourceType && sourceType !== 'url') {
      continue
    }

    const url =
      typeof (source as { url?: unknown }).url === 'string'
        ? ((source as { url?: string }).url ?? '')
        : ''

    if (!url) continue

    const title =
      typeof (source as { title?: unknown }).title === 'string'
        ? cleanText((source as { title?: string }).title ?? '')
        : ''

    results.push({
      title: title || `Referenced source for "${query}"`,
      url,
      snippet: title
        ? `Source cited for "${title}"`
        : `Source referenced for "${query}"`,
      publishedDate: undefined,
      source: extractSourceFromUrl(url),
    })
  }

  return results
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
  const normalizedTitle = title.trim().toLowerCase()

  if (normalizedTitle) {
    const existingByTitle = await query(
      "SELECT id FROM articles WHERE LOWER(title) = $1 AND fetched_at > NOW() - INTERVAL '48 hours'",
      [normalizedTitle]
    )

    if (existingByTitle.rows.length > 0) {
      return true
    }
  }

  return false
}

async function getOrCreateSourceForResult(
  result: WebSearchResult,
  fallbackSourceId: number
): Promise<{
  sourceId: number
  publisherName?: string | null
  publisherHomepage?: string | null
}> {
  const host = hostFromUrl(result.url)

  if (!host || HOST_BLOCKLIST.has(host)) {
    return {
      sourceId: fallbackSourceId,
      publisherName: result.source?.trim() || null,
      publisherHomepage: null,
    }
  }

  const cached = sourceCache.get(host)
  if (cached) {
    return {
      sourceId: cached,
      publisherName: result.source?.trim() || humanizeHost(host),
      publisherHomepage: `https://${host}`,
    }
  }

  const slug = slugifyHost(host)
  const feedUrl = `web://${host}`
  const homepage = `https://${host}`
  const publisherName = result.source?.trim() || humanizeHost(host)

  const existing = await query<{ id: number }>(
    `
      SELECT id
      FROM sources
      WHERE slug = $1
         OR feed_url = $2
         OR lower(coalesce(homepage_url, '')) LIKE $3
      ORDER BY weight DESC
      LIMIT 1
    `,
    [slug, feedUrl, `%${host}%`]
  )

  let sourceId = existing.rows[0]?.id

  if (!sourceId) {
    const inserted = await query<{ id: number }>(
      `
        INSERT INTO sources (name, homepage_url, feed_url, weight, slug)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (feed_url) DO UPDATE
          SET name = EXCLUDED.name,
              homepage_url = EXCLUDED.homepage_url,
              weight = EXCLUDED.weight,
              slug = EXCLUDED.slug
        RETURNING id
      `,
      [publisherName, homepage, feedUrl, 4, slug]
    )
    sourceId = inserted.rows[0]?.id
  }

  if (!sourceId) {
    return {
      sourceId: fallbackSourceId,
      publisherName,
      publisherHomepage: homepage,
    }
  }

  sourceCache.set(host, sourceId)

  return {
    sourceId,
    publisherName,
    publisherHomepage: homepage,
  }
}

async function insertWebDiscoveredArticle(
  result: WebSearchResult,
  sourceId: number,
  publisherName?: string | null,
  publisherHomepage?: string | null
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
        fetched_at,
        publisher_name,
        publisher_homepage
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
      RETURNING id
    `,
      [
        sourceId,
        result.title,
        result.url,
        result.snippet,
        normalizePublishedDate(result.publishedDate) ?? new Date(),
        publisherName ?? null,
        publisherHomepage ?? null,
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
  const existing = await query<{ id: number }>(
    'SELECT id FROM sources WHERE slug = $1',
    ['web-discovery']
  )

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

type DiscoverySegmentStats = {
  inserted: number
  scanned: number
  queriesRun: number
  browseCost: number
  browseToolCalls: number
  duration: number
}

async function tryInsertDiscoveredArticle(
  result: WebSearchResult,
  fallbackSourceId: number
): Promise<boolean> {
  const isClimate = isClimateRelevant({
    title: result.title,
    summary: result.snippet ?? undefined,
  })

  if (!isClimate) {
    const host = hostFromUrl(result.url) || result.source || 'unknown source'
    console.log(
      `- Skipped non-climate result from ${host}: ${result.title.substring(0, 80)}`
    )
    return false
  }

  const duplicate = await isDuplicate(result.title, result.url)

  if (duplicate) {
    console.log(`- Skipped duplicate: ${result.title.substring(0, 60)}...`)
    return false
  }

  const { sourceId, publisherName, publisherHomepage } =
    await getOrCreateSourceForResult(result, fallbackSourceId)

  const articleId = await insertWebDiscoveredArticle(
    result,
    sourceId,
    publisherName,
    publisherHomepage
  )

  if (!articleId) {
    return false
  }

  await ensureClusterForArticle(articleId, result.title)

  try {
    await categorizeAndStoreArticle(
      articleId,
      result.title,
      result.snippet || undefined
    )
    console.log(`✓ Added & categorized: ${result.title.substring(0, 60)}...`)
  } catch (error) {
    console.error(`  ❌ Failed to categorize article ${articleId}:`, error)
    console.log(`✓ Added (uncategorized): ${result.title.substring(0, 60)}...`)
  }

  return true
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, size)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

function buildOutletBatches(batchSize: number): ClimateOutlet[][] {
  const byDomain = new Map(
    CURATED_CLIMATE_OUTLETS.map((outlet) => [outlet.domain, outlet])
  )
  const assigned = new Set<string>()
  const batches: ClimateOutlet[][] = []

  for (const domains of OUTLET_BATCH_DOMAIN_GROUPS) {
    const batch = domains
      .map((domain) => {
        const outlet = byDomain.get(domain)
        if (outlet && !assigned.has(domain)) {
          assigned.add(domain)
          return outlet
        }
        return null
      })
      .filter((outlet): outlet is ClimateOutlet => Boolean(outlet))

    if (batch.length > 0) {
      batches.push(batch)
    }
  }

  const leftovers = CURATED_CLIMATE_OUTLETS.filter(
    (outlet) => !assigned.has(outlet.domain)
  )

  for (const chunk of chunkArray(leftovers, batchSize)) {
    if (chunk.length > 0) {
      batches.push(chunk)
    }
  }

  return batches
}

async function runOutletDiscoverySegment({
  fallbackSourceId,
  limitPerBatch,
  batchSize,
  articleCap,
  freshHours,
}: {
  fallbackSourceId: number
  limitPerBatch: number
  batchSize: number
  articleCap: number
  freshHours: number
}): Promise<DiscoverySegmentStats> {
  if (CURATED_CLIMATE_OUTLETS.length === 0 || articleCap <= 0) {
    return {
      inserted: 0,
      scanned: 0,
      queriesRun: 0,
      browseCost: 0,
      browseToolCalls: 0,
      duration: 0,
    }
  }

  const segmentStart = Date.now()
  const outletBatches = buildOutletBatches(batchSize)
  const freshnessCutoffMs =
    freshHours > 0 ? Date.now() - freshHours * 60 * 60 * 1000 : null

  let inserted = 0
  let scanned = 0
  let queriesRun = 0
  let browseCost = 0
  let browseToolCalls = 0
  const outletFallbackAttempts = new Set<string>()

  for (const batch of outletBatches) {
    if (inserted >= articleCap) {
      break
    }

    const outletNames = batch.map((outlet) => outlet.promptHint || outlet.name)
    const outletDescriptors = batch.map((outlet) =>
      outlet.promptHint ? `${outlet.name} (${outlet.promptHint})` : outlet.name
    )
    const domains = batch.map((outlet) => outlet.domain)
    const normalizedDomainEntries = batch.map((outlet) => ({
      outlet,
      raw: outlet.domain,
      normalized: normalizeDomain(outlet.domain),
    }))

    console.log(`Searching (site-specific batch): ${outletNames.join(', ')}`)

    const targetedSystemPrompt = `You are ClimateRiver's climate outlet curator. For each outlet you must issue at least one precise site:domain query that reflects the outlet's specialty while keeping total tool calls as low as possible. Only keep original articles published in the past ${freshHours} hours. Reject syndicated content, opinion newsletters, or aggregator redirections. Double-check that every URL's hostname belongs to the allowed domain list and drop any entry without a confirmed ISO timestamp. Respond with a JSON array sorted newest to oldest containing title, url, snippet (why the story matters), publishedDate (ISO), and source.`
    const targetedUserPrompt = `Provide up to ${limitPerBatch} combined articles across these outlets: ${outletDescriptors.join('; ')}. Use site-specific queries (e.g., site:domain "topic") tailored to each prompt hint, and when possible include at least one qualifying link per outlet. Only include URLs from ${domains.join(', ')} or their official climate sections, ensure every item was published within the last ${freshHours} hours, and omit any link that fails those tests. Return only the JSON array sorted newest to oldest.`

    const { results: initialResults, browseStats } =
      await callOpenAIEnhancedSearch(
        `Latest climate coverage across: ${domains.join(', ')}`,
        {
          systemPrompt: targetedSystemPrompt,
          userPrompt: targetedUserPrompt,
          allowedDomains: domains,
          resultLimit: limitPerBatch,
        }
      )

    queriesRun++

    if (browseStats) {
      browseCost += browseStats.estimatedCost
      browseToolCalls += browseStats.toolCalls
    }

    let batchResults = [...initialResults]

    const domainHitCounts = new Map<string, number>()
    updateDomainHitCounts(
      domainHitCounts,
      batchResults,
      normalizedDomainEntries.map((entry) => entry.normalized)
    )

    const missingDomainEntries = normalizedDomainEntries.filter(
      (entry) => (domainHitCounts.get(entry.normalized) ?? 0) === 0
    )

    for (const entry of missingDomainEntries) {
      if (inserted >= articleCap) break
      if (outletFallbackAttempts.has(entry.normalized)) {
        continue
      }
      outletFallbackAttempts.add(entry.normalized)

      const fallbackResultLimit = Math.min(4, limitPerBatch)
      const fallbackSystemPrompt = `You are ClimateRiver's climate outlet curator focusing exclusively on ${entry.outlet.name}. Use the web search tool with site:${entry.raw} queries, confirm every link belongs to ${entry.raw}, keep total tool calls minimal, and only return articles published within the last ${freshHours} hours. Reject summaries, newsletters, or paywall notices. Respond only with JSON (title, url, snippet, publishedDate ISO, source) sorted newest to oldest.`
      const fallbackUserPrompt = `Provide up to ${fallbackResultLimit} original climate or energy stories from ${entry.outlet.name} (${entry.outlet.promptHint ?? 'climate desk'}) published within the last ${freshHours} hours. Only include URLs from ${entry.raw} or its official subdomains and omit any item without a trustworthy timestamp.`

      console.log(
        `🔁 Running fallback search for ${entry.outlet.name} (${entry.raw})`
      )
      const { results: fallbackResults, browseStats: fallbackBrowse } =
        await callOpenAIEnhancedSearch(
          `Latest climate coverage from: ${entry.raw}`,
          {
            systemPrompt: fallbackSystemPrompt,
            userPrompt: fallbackUserPrompt,
            allowedDomains: [entry.raw],
            resultLimit: fallbackResultLimit,
          }
        )

      queriesRun++

      if (fallbackBrowse) {
        browseCost += fallbackBrowse.estimatedCost
        browseToolCalls += fallbackBrowse.toolCalls
      }

      if (fallbackResults.length === 0) {
        console.log(
          `⚠️  Fallback search returned no results for ${entry.outlet.name}`
        )
        continue
      }

      console.log(
        `✅ Fallback recovered ${fallbackResults.length} result(s) for ${entry.outlet.name}`
      )
      batchResults.push(...fallbackResults)
      updateDomainHitCounts(domainHitCounts, fallbackResults, [
        entry.normalized,
      ])
    }

    batchResults = dedupeWebResults(batchResults)
    scanned += batchResults.length

    for (const result of batchResults) {
      if (inserted >= articleCap) break
      if (freshnessCutoffMs && !isResultFresh(result, freshnessCutoffMs)) {
        console.log(
          `- Skipped stale (${result.publishedDate ?? 'unknown'}): ${result.title.substring(0, 80)}`
        )
        continue
      }
      const added = await tryInsertDiscoveredArticle(result, fallbackSourceId)
      if (added) {
        inserted++
      }
    }

    if (inserted >= articleCap) break
    await delay(DISCOVERY_PAUSE_MS)
  }

  return {
    inserted,
    scanned,
    queriesRun,
    browseCost,
    browseToolCalls,
    duration: Math.round((Date.now() - segmentStart) / 1000),
  }
}

export async function run(
  opts: {
    closePool?: boolean
    outletArticleCap?: number
    outletLimitPerBatch?: number
    outletBatchSize?: number
    outletFreshHours?: number
  } = {}
) {
  const startTime = Date.now()
  const outletArticleCap = opts.outletArticleCap ?? 70
  const outletLimitPerBatch = Math.max(4, opts.outletLimitPerBatch ?? 12)
  const outletBatchSize = Math.max(2, opts.outletBatchSize ?? 4)
  const outletFreshHours =
    opts.outletFreshHours ?? DEFAULT_OUTLET_FRESHNESS_HOURS

  console.log('Starting site-specific web discovery (batched)...')

  const fallbackSourceId = await getOrCreateWebDiscoverySource()

  const outletStats = await runOutletDiscoverySegment({
    fallbackSourceId,
    limitPerBatch: outletLimitPerBatch,
    batchSize: outletBatchSize,
    articleCap: outletArticleCap,
    freshHours: outletFreshHours,
  })

  if (outletStats.queriesRun > 0) {
    console.log(
      `Curated outlet tier complete: ${outletStats.inserted} new articles from ${outletStats.scanned} results`
    )
  } else {
    console.log(
      'Curated outlet tier skipped (no outlets configured or article cap set to 0)'
    )
  }

  const totalInserted = outletStats.inserted
  const totalScanned = outletStats.scanned
  const totalBrowseCost = outletStats.browseCost
  const totalBrowseToolCalls = outletStats.browseToolCalls
  const totalQueries = outletStats.queriesRun

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
    queriesRun: totalQueries,
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
