// scripts/discover-web.ts
import { query, endPool } from '@/lib/db'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

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

async function callOpenAIEnhancedSearch(
  query: string
): Promise<WebSearchResult[]> {
  try {
    console.log(`OpenAI Enhanced Search: ${query}`)

    // Use AI SDK's generateText with a smart prompt that suggests real news sources
    const { text } = await generateText({
      model: openai('gpt-5-nano'),
      messages: [
        {
          role: 'system',
          content: `You are a climate news expert. Based on your training data and knowledge of major news outlets, suggest specific article searches for Google News RSS that would find recent stories about the given topic. 

Focus on:
- Specific search terms that would work well in Google News
- Recent developments in climate/environment
- Stories likely to be covered by major outlets
- Breaking news or trending topics

Return your response as a JSON array with this format:
[
  {
    "searchTerm": "specific search phrase for Google News",
    "reasoning": "why this search would find relevant articles",
    "expectedSources": ["source1", "source2"]
  }
]`,
        },
        {
          role: 'user',
          content: `Suggest 3-5 specific Google News search terms for: "${query}". Focus on recent climate/environmental news that major outlets would cover.`,
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 1000,
    })

    // Extract search suggestions and execute them
    const results = await executeAISearchSuggestions(text)
    return results
  } catch (error) {
    console.error('Error calling OpenAI enhanced search:', error)
    return []
  }
}

async function executeAISearchSuggestions(
  content: string
): Promise<WebSearchResult[]> {
  try {
    // Parse the JSON suggestions from OpenAI
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.log('No JSON array found in AI response')
      return []
    }

    const suggestions = JSON.parse(jsonMatch[0])
    console.log(`AI suggested ${suggestions.length} search terms`)

    const allResults: WebSearchResult[] = []

    // Execute each suggested search term against Google News RSS
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
          results.push({
            title: line.replace(/^[\d\.\s]*/, '').trim(),
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

      if (correspondingUrl && title.length > 10) {
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

  const selectedQueries = querySet.slice(0, maxQueries)

  for (const query of selectedQueries) {
    console.log(`Searching: ${query}`)

    const results = await callOpenAIEnhancedSearch(query)
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
          inserted++
          totalInserted++
          console.log(`✓ Added: ${result.title.substring(0, 60)}...`)
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

  if (opts.closePool) {
    await endPool()
  }

  return {
    totalInserted,
    totalScanned,
    duration,
    queriesRun: selectedQueries.length,
  }
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true }).catch((err) => {
    console.error(err)
    endPool().finally(() => process.exit(1))
  })
}
