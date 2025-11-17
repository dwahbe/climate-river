// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'
import { isClimateRelevant } from '@/lib/tagger'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

type ClusterContextItem = {
  article_id: number
  title: string
  source: string | null
}

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
  content_text: string | null
  content_html: string | null
  content_status: string | null
  cluster_id: number | null
  cluster_context: ClusterContextItem[] | null
}

/* ------------------------- Content Extraction with Safety Checks ------------------------- */

/**
 * Extract a meaningful snippet from article content with comprehensive safety checks
 * Prioritizes first few paragraphs (the lede) while filtering out paywalls and garbage
 */
function extractContentSnippet(
  contentText: string | null,
  contentHtml: string | null,
  maxChars = 600
): string | null {
  const text = contentText || contentHtml
  if (!text) return null

  // Strip HTML tags if present
  let cleaned = text.replace(/<[^>]+>/g, ' ') // TODO: Use a HTML parser to strip tags
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  // 🛡️ SAFETY CHECK 1: Minimum viable length
  if (cleaned.length < 100) {
    console.warn('⚠️  Content too short (<100 chars), skipping')
    return null
  }

  // 🛡️ SAFETY CHECK 2: Detect paywall language
  const paywallPatterns = [
    /subscribe/i,
    /subscription/i,
    /sign in/i,
    /member/i,
    /premium/i,
    /paywall/i,
  ]
  const firstPart = cleaned.slice(0, 200)
  if (paywallPatterns.some((p) => p.test(firstPart))) {
    console.warn('⚠️  Paywall detected in content, skipping')
    return null
  }

  // 🛡️ SAFETY CHECK 3: Word count sanity
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0)
  if (words.length < 30) {
    console.warn('⚠️  Content too few words (<30), skipping')
    return null
  }

  // 🛡️ SAFETY CHECK 4: Uniqueness ratio (detect repetitive error pages)
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()))
  if (uniqueWords.size < words.length * 0.3) {
    console.warn('⚠️  Content too repetitive, skipping')
    return null
  }

  // Extract first few sentences (usually the lead)
  const sentences = cleaned.split(/[.!?]+\s+/)
  let snippet = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed.length < 10) continue // Skip tiny fragments

    if (snippet.length + trimmed.length > maxChars) break
    snippet += (snippet ? ' ' : '') + trimmed + '.'
  }

  // Final validation
  return snippet.length >= 50 ? snippet : null
}

/* ------------------------- Techmeme-Style Prompt ------------------------- */

function buildPrompt(input: {
  title: string
  dek?: string | null
  contentSnippet?: string | null
  previewExcerpt?: string | null
  clusterContext?: ClusterContextItem[]
}) {
  const lines = [
    'Rewrite this climate news headline in the style of Techmeme - dense, factual, scannable, with all key details.',
    '',
    'STRUCTURE (Techmeme style):',
    '- Lead with WHO (agency/company/court/institution)',
    '- Follow with strong action verb (announces, blocks, requires, finds, cuts, raises)',
    '- Add specific WHAT with details; only cite numbers that were provided',
    '- End with WHY/IMPACT in natural clause',
    '- Use commas to separate clauses, not complex sentence structures',
    '',
    'SPECIFICITY REQUIRED:',
    '- ONLY include numbers or quantitative claims that appear in the supplied material (title, summary, excerpt, preview article, or cluster context)',
    '- If no quantitative details exist, keep the rewrite qualitative but still concrete',
    '- Do not invent stats, measurements, dates, or sources; omit missing data instead of guessing',
    '- Preview excerpts (when provided) are the verified article text—quote them faithfully',
    '- Name specific entities: "EPA", "Ørsted", "Federal Appeals Court", not "regulators" or "companies"',
    '- Include timeframes: "by 2030", "from 2025-2028", "starting Q1 2026"',
    '- Product/policy names: Exact titles, not generic descriptions',
    '- Give concrete examples when possible',
    '',
    'CLIMATE-SPECIFIC PATTERNS:',
    '- Policy: "[Agency] [action verb] [rule/standard], requiring [entities] to [specific action] by [date], citing [reason]"',
    '  Example: "EPA finalizes power plant emissions rule, requiring coal facilities to cut CO2 80% by 2032, citing climate goals"',
    '',
    '- Corporate: "[Company] [action] [project/investment], [size/scale with numbers], [reason/context]"',
    '  Example: "Ørsted cancels 2.6GW New Jersey offshore wind project, cites supply chain costs and rate caps"',
    '',
    '- Legal: "[Court level] [ruling action] [case/project], citing [specific legal issue]"',
    '  Example: "Federal appeals court blocks Mountain Valley Pipeline, citing insufficient climate impact review"',
    '',
    '- Science: "[Institution] study finds [specific finding], [magnitude/numbers], [implication]"',
    '  Example: "Nature study finds Amazon emitting more CO2 than it absorbs, driven by 15% deforestation increase"',
    '',
    '- Technology: "[Company] [announces/demonstrates] [technology], achieving [metrics], targeting [application]"',
    '  Example: "Form Energy demonstrates 100-hour iron-air battery, targets grid-scale seasonal storage"',
    '',
    'STYLE RULES:',
    '- Present tense, active voice',
    '- 120-160 characters ideal (Techmeme density)',
    '- No period at end',
    '- Repeat quantitative figures exactly as provided; no rounding or new units',
    '- No hype words: "revolutionary", "game-changer", "unprecedented", "major breakthrough"',
    '- No vague phrases: "significant", "important" (show don\'t tell with numbers)',
    '- No questions, puns, or editorial voice',
    '- No weak hedging: "may", "could", "might", "possibly"',
    '',
    'SOURCE MATERIAL:',
    `Original headline: ${input.title}`,
  ]

  if (input.dek) {
    lines.push(`Summary: ${input.dek}`)
  }

  if (input.contentSnippet) {
    lines.push(`Article excerpt: ${input.contentSnippet}`)
  }

  if (input.previewExcerpt) {
    lines.push(
      `Preview article excerpt (from Climate River reader): ${input.previewExcerpt}`
    )
  }

  if (input.clusterContext && input.clusterContext.length > 0) {
    lines.push('')
    lines.push('OTHER COVERAGE (cluster context):')
    lines.push(
      '  (Treat these as verified related reports; reuse their exact figures if relevant)'
    )
    for (const related of input.clusterContext.slice(0, 3)) {
      const sourceLabel = related.source
        ? `${related.source}:`
        : 'Related article:'
      lines.push(`- ${sourceLabel} ${related.title}`)
    }
  }

  lines.push('')
  lines.push(
    'OUTPUT: Rewritten headline only (no quotes, no explanation, no "Here is...")'
  )

  return lines.join('\n')
}

function sanitizeHeadline(s: string) {
  let t = (s || '')
    .replace(/^[""'\s]+|[""'\s]+$/g, '') // strip quotes
    .replace(/\s+/g, ' ') // collapse spaces
    .trim()
  // Remove trailing periods and other decorative punctuation
  t = t.replace(/[-.|•–—]+$/g, '').trim()
  return t
}

const QUANTIFIER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
  'billion',
  'trillion',
  'percent',
  'percentage',
]

const QUANTIFIER_REGEXES = QUANTIFIER_WORDS.map(
  (word) => new RegExp(`\\b${word}\\b`, 'i')
)

function containsQuantifier(headline: string) {
  if (/\d/.test(headline)) return true
  return QUANTIFIER_REGEXES.some((regex) => regex.test(headline))
}

const NUMBER_WORD_MAP: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
}

const SPELLED_NUMBER_REGEX = new RegExp(
  `\\b(${Object.keys(NUMBER_WORD_MAP).join('|')})\\b`,
  'gi'
)

const NUMERIC_TOKEN_REGEX =
  /\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent))?/gi

function normalizeNumericToken(token: string): string | null {
  if (!token) return null
  let normalized = token.toLowerCase().trim()
  if (!normalized) return null
  normalized = normalized.replace(/,/g, '')
  normalized = normalized.replace(/percent$/i, '%')
  normalized = normalized.replace(/\s+/g, '')
  normalized = normalized.replace(/[^0-9.%]/g, '')
  normalized = normalized.replace(/\.(?=.*\.)/g, '')
  normalized = normalized.replace(/\.$/, '')
  if (!/\d/.test(normalized)) return null
  return normalized
}

function extractNumericTokens(text: string | null | undefined): string[] {
  if (!text) return []
  const matches = text.match(NUMERIC_TOKEN_REGEX)
  if (!matches) return []
  return matches
    .map((token) => normalizeNumericToken(token))
    .filter((token): token is string => Boolean(token))
}

function extractSpelledNumberTokens(text: string | null | undefined): string[] {
  if (!text) return []
  const tokens: string[] = []
  SPELLED_NUMBER_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPELLED_NUMBER_REGEX.exec(text)) !== null) {
    const mapped = NUMBER_WORD_MAP[match[1].toLowerCase()]
    if (mapped) tokens.push(mapped)
  }
  return tokens
}

type QuantContext = {
  hasQuantEvidence: boolean
  numbers: Set<string>
}

type ValidationContext = {
  hasContent: boolean
  sourceQuant: QuantContext
}

function buildSourceQuantContext(
  parts: Array<string | null | undefined>
): QuantContext {
  const filtered = parts.filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0
  )
  if (filtered.length === 0) {
    return { hasQuantEvidence: false, numbers: new Set() }
  }
  const MAX_SEGMENT_LENGTH = 12000
  const combined = filtered
    .map((segment) =>
      segment.length > MAX_SEGMENT_LENGTH
        ? segment.slice(0, MAX_SEGMENT_LENGTH)
        : segment
    )
    .join(' ')
  const numbers = new Set([
    ...extractNumericTokens(combined),
    ...extractSpelledNumberTokens(combined),
  ])
  return {
    hasQuantEvidence: containsQuantifier(combined),
    numbers,
  }
}

/* ------------------------- Enhanced Validation ------------------------- */

function passesChecks(
  original: string,
  draft: string,
  context: ValidationContext
) {
  if (!draft) return false
  const t = sanitizeHeadline(draft)
  const { hasContent, sourceQuant } = context

  // Techmeme-style density: allow more flexibility for high-quality specificity
  const minLength = hasContent ? 60 : 50
  if (t.length < minLength || t.length > 170) {
    console.warn(
      `⚠️  Length check failed (${t.length} chars): "${t.slice(0, 50)}..."`
    )
    return false
  }

  // Require quantifier only when source provides quantitative backing
  if (sourceQuant.hasQuantEvidence && !containsQuantifier(t)) {
    console.warn(
      `⚠️  Source has quantitative detail but rewrite lacks it: "${t.slice(
        0,
        50
      )}..."`
    )
    return false
  }

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, ' ')
      .trim()

  // Must be different from original
  if (!norm(t) || norm(t) === norm(original)) {
    console.warn(`⚠️  Headline unchanged from original`)
    return false
  }

  // Word count check - allow shorter if more specific
  const originalWords = original.split(/\s+/).length
  const draftWords = t.split(/\s+/).length

  if (hasContent) {
    // With content, allow slightly shorter if more specific (90% threshold)
    if (draftWords < originalWords * 0.9) {
      console.warn(`⚠️  Headline shorter than original despite having content`)
      return false
    }
  } else {
    // Without content, allow reasonable compression
    if (draftWords < originalWords * 0.6) {
      console.warn(`⚠️  Headline too compressed`)
      return false
    }
  }

  // Ensure numeric claims exist in source material
  const draftNumbers = extractNumericTokens(t)
  if (draftNumbers.length > 0) {
    if (sourceQuant.numbers.size === 0) {
      console.warn(
        `⚠️  Numeric detail missing in source but present in rewrite: ${draftNumbers.join(
          ', '
        )}`
      )
      return false
    }
    const missingNumbers = draftNumbers.filter(
      (num) => !sourceQuant.numbers.has(num)
    )
    if (missingNumbers.length > 0) {
      console.warn(
        `⚠️  Numeric mismatch: ${missingNumbers.join(
          ', '
        )} not found in source material`
      )
      return false
    }
  }

  // Check for vague/hype phrases that shouldn't be in good headlines
  const badPatterns = [
    /\bmajor\b.*\bbreakthrough\b/i,
    /\bgame.?chang/i,
    /\brevolutionary\b/i,
    /\bunprecedented\b/i,
    /\bslam/i, // "X slams Y" - too casual
    /\bblast/i, // "X blasts Y" - too tabloid
    /\brip/i, // "X rips Y" - too informal
  ]

  if (badPatterns.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected vague/hype language: "${t.slice(0, 50)}..."`)
    return false
  }

  // Check for weak hedging language
  const weakPatterns = [/\bmay\b/i, /\bcould\b/i, /\bmight\b/i, /\bpossibly\b/i]

  if (weakPatterns.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected weak hedging language: "${t.slice(0, 50)}..."`)
    return false
  }

  // Check for climate context (at least one climate-related term)
  const climateTerms = [
    /\b(climate|carbon|emission|renewable|fossil|solar|wind|epa|greenhouse|warming|energy|environmental?)\b/i,
    /\b(ev|evs|electric[- ]vehicles?|electric[- ]cars?|plug-in|battery[- ]electric)\b/i,
    /\b(battery|charging station|charging network|grid storage|long-duration storage)\b/i,
    /\b(flood|floods|flooding|drought|droughts|storm surge|hurricane|typhoon|cyclone|tornado)\b/i,
    /\b(wildfire|wildfires|fire danger|fire weather|smoke plume|smoke plumes)\b/i,
    /\b(heatwave|heat wave|heatwaves|heat waves|heat dome|heat domes|heat index|extreme heat)\b/i,
    /\b(crop yield|crop yields|harvest|agricultural|farmers|food security|food supply)\b/i,
    /\b(oil|gas|methane|petroleum|petrochemical|refinery|refineries|diesel|jet fuel)\b/i,
    /\b(coal|mining|miners|mine|strip mine|mountaintop removal)\b/i,
    /\b(fracking|drilling|offshore rig|rigs|pipeline|pipelines|liquefied natural gas|lng)\b/i,
    /\b(pollution|pollutants|air quality|soot|smog)\b/i,
    /\b(hydrogen|ammonia|electrolyzer|carbon capture|ccs|direct air capture)\b/i,
    /\b(nuclear|reactor|reactors|fusion|fission)\b/i,
    /\b(sunrise movement|greenpeace|sierra club|friends of the earth|350\.org|earthjustice|world wildlife fund|wwf|green new deal network|union of concerned scientists|campus climate network)\b/i,
  ]

  if (!climateTerms.some((p) => p.test(t))) {
    console.warn(`⚠️  Rejected non-climate headline: "${t.slice(0, 50)}..."`)
    return false
  }

  return true
}

/* ------------------------- LLM Generation ------------------------- */

async function generateWithOpenAI(
  input: {
    title: string
    dek?: string | null
    contentSnippet?: string | null
    previewExcerpt?: string | null
    clusterContext?: ClusterContextItem[]
  },
  abortMs = 20000,
  retries = 2
): Promise<{ text: string | null; model: string; notes: string }> {
  const prompt = buildPrompt(input)
  const model = 'gpt-4o-mini'

  try {
    const { text } = await generateText({
      model: openai(model),
      prompt,
      temperature: 0.3, // Slightly higher for more natural phrasing
      maxOutputTokens: 50, // Lower - headlines shouldn't need much
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(abortMs),
    })

    const sanitized = sanitizeHeadline(text)
    const notesParts = [
      input.contentSnippet
        ? `with_content:${input.contentSnippet.length}chars`
        : 'title_only',
    ]

    if (input.previewExcerpt) {
      notesParts.push(`with_preview:${input.previewExcerpt.length}chars`)
    } else {
      notesParts.push('no_preview')
    }

    if (input.clusterContext && input.clusterContext.length > 0) {
      notesParts.push(
        `with_cluster:${Math.min(input.clusterContext.length, 5)}`
      )
    } else {
      notesParts.push('no_cluster')
    }

    return {
      text: sanitized,
      model,
      notes: `success:${notesParts.join(':')}`,
    }
  } catch (error: unknown) {
    console.error('❌ Error generating text with AI SDK:', error)
    const message = error instanceof Error ? error.message : 'unknown_error'
    const failureParts = [
      `failed:${message}`,
      input.clusterContext && input.clusterContext.length > 0
        ? `with_cluster:${Math.min(input.clusterContext.length, 5)}`
        : 'no_cluster',
    ]
    return {
      text: null,
      model,
      notes: failureParts.join(':'),
    }
  }
}

/* ------------------------------- Runner -------------------------------- */

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>
) {
  const ret: R[] = new Array(items.length)
  let i = 0
  let active = 0
  return new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret)
      while (active < limit && i < items.length) {
        const cur = i++
        active++
        fn(items[cur], cur)
          .then((v) => (ret[cur] = v))
          .catch(reject)
          .finally(() => {
            active--
            next()
          })
      }
    }
    next()
  })
}

async function fetchBatch(limit = 40) {
  const { rows } = await query<Row>(
    `
      select 
        a.id, 
        a.title, 
        a.dek, 
        a.canonical_url,
        a.content_text,
        a.content_html,
        a.content_status,
        cluster_map.cluster_id,
        cluster_ctx.cluster_context
      from articles a
      left join lateral (
        select ac.cluster_id
        from article_clusters ac
        where ac.article_id = a.id
        order by ac.cluster_id desc
        limit 1
      ) cluster_map on true
      left join lateral (
        select jsonb_agg(item) as cluster_context
        from (
          select jsonb_build_object(
            'article_id', a2.id,
            'title', coalesce(a2.rewritten_title, a2.title),
            'source', coalesce(a2.publisher_name, s2.name)
          ) as item
          from article_clusters ac2
          join articles a2 on a2.id = ac2.article_id
          left join sources s2 on s2.id = a2.source_id
          where cluster_map.cluster_id is not null
            and ac2.cluster_id = cluster_map.cluster_id
            and ac2.article_id <> a.id
          order by a2.published_at desc
          limit 5
        ) as cluster_items
      ) cluster_ctx on true
      left join lateral (
        select cs.score
        from cluster_scores cs
        where cs.lead_article_id = a.id
        limit 1
      ) score_map on true
      where a.rewritten_title is null
        and coalesce(a.published_at, now()) > now() - interval '21 days'
        and exists (
          select 1
          from article_categories ac
          where ac.article_id = a.id
        )
        and (
          a.rewrite_notes is null
          or a.rewrite_notes not like 'skipped:not_climate%'
        )
      order by 
        score_map.score desc nulls last,
        a.fetched_at desc
      limit $1
    `,
    [limit]
  )
  return rows
}

async function processOne(r: Row) {
  // SAFETY LAYER 1: Only use content if status is explicitly 'success'
  const contentSnippet =
    r.content_status === 'success'
      ? extractContentSnippet(r.content_text, r.content_html)
      : null

  const previewExcerpt =
    r.content_status === 'success' &&
    typeof r.content_html === 'string' &&
    r.content_html.trim().length > 0
      ? extractContentSnippet(null, r.content_html, 1500)
      : null

  const clusterContext: ClusterContextItem[] = Array.isArray(r.cluster_context)
    ? (() => {
        const seen = new Set<string>()
        const items: ClusterContextItem[] = []
        for (const item of r.cluster_context) {
          if (!item || !item.title) continue
          const normalizedSource = item.source ?? null
          const dedupeKey = `${normalizedSource?.toLowerCase() || ''}|${item.title}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          items.push({
            article_id: item.article_id,
            title: item.title,
            source: normalizedSource,
          })
        }
        return items
      })()
    : []

  // Track what happened with content
  let contentNote = ''
  if (!r.content_status) {
    contentNote = ':no_content'
  } else if (r.content_status !== 'success') {
    contentNote = `:${r.content_status}` // :paywall, :blocked, :timeout, etc.
  } else if (!contentSnippet) {
    contentNote = ':content_rejected' // Had content but failed quality checks
  }

  const clusterTitles = clusterContext.map((item) => item.title).filter(Boolean)

  const sourceQuant = buildSourceQuantContext([
    r.title,
    r.dek,
    contentSnippet,
    previewExcerpt,
    r.content_text,
    r.content_html,
    ...clusterTitles,
  ])

  const aggregatedClusterTitles =
    clusterTitles.length > 0 ? clusterTitles.join(' ') : ''
  const climateSummaryParts = [
    r.dek,
    contentSnippet,
    previewExcerpt,
    r.content_text,
    r.content_html,
    aggregatedClusterTitles,
  ].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0
  )

  const isClimate = isClimateRelevant({
    title: r.title,
    summary:
      climateSummaryParts.length > 0
        ? climateSummaryParts.join(' ')
        : undefined,
  })

  if (!isClimate) {
    const notes = 'skipped:not_climate'
    await query(
      `update articles
         set rewrite_model = $1,
             rewrite_notes = $2
       where id = $3`,
      ['skipped', notes, r.id]
    )
    console.log(
      `🚫 [${r.id}] Skipped rewrite (non-climate detected): "${r.title.slice(
        0,
        80
      )}..."`
    )
    return { ok: 0, failed: 1 }
  }

  const llm = await generateWithOpenAI({
    title: r.title,
    dek: r.dek,
    contentSnippet,
    previewExcerpt,
    clusterContext,
  })
  const draft = llm.text || ''

  if (
    passesChecks(r.title, draft, {
      hasContent: !!contentSnippet,
      sourceQuant,
    })
  ) {
    const notes = llm.notes + contentNote

    await query(
      `update articles
         set rewritten_title = $1,
             rewritten_at   = now(),
             rewrite_model  = $2,
             rewrite_notes  = $3
       where id = $4`,
      [draft, llm.model || 'unknown', notes, r.id]
    )
    console.log(
      `✅ [${r.id}] "${r.title.slice(0, 40)}..." → "${draft.slice(0, 60)}..."`
    )
    return { ok: 1, failed: 0 }
  }

  // Leave original title; just record why it failed.
  await query(
    `update articles
       set rewrite_model = $1,
           rewrite_notes = $2
     where id = $3`,
    [llm.model || 'none', llm.notes + contentNote || 'no_valid_rewrite', r.id]
  )
  console.log(`⚠️  [${r.id}] Failed validation: "${r.title.slice(0, 50)}..."`)
  return { ok: 0, failed: 1 }
}

async function batch(limit = 40, concurrency = 4) {
  const rows = await fetchBatch(limit)
  console.log(`📝 Processing ${rows.length} articles...`)

  let ok = 0
  let failed = 0

  await mapLimit(rows, concurrency, async (r) => {
    const res = await processOne(r)
    ok += res.ok
    failed += res.failed
  })

  return { count: rows.length, ok, failed }
}

export async function run(opts: { limit?: number; closePool?: boolean } = {}) {
  console.log('🔄 Starting headline rewrite job...')
  const start = Date.now()

  const res = await batch(opts.limit ?? 40, 4)

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(
    `✅ Rewrite complete: ${res.ok} succeeded, ${res.failed} failed (${elapsed}s)`
  )

  if (opts.closePool) await endPool()
  return res
}

// CLI support: `npm run rewrite`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cliOpts = parseCliArgs(process.argv.slice(2))
  run({ ...cliOpts, closePool: true })
    .then((r) => {
      console.log('\n📊 Final results:', r)
      process.exit(r.ok > 0 ? 0 : 1)
    })
    .catch((err) => {
      console.error('❌ Fatal error:', err)
      process.exit(1)
    })
}

type CliOptions = {
  limit?: number
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--limit' || arg === '-l') {
      const next = argv[i + 1]
      if (!next) {
        console.warn('⚠️  --limit flag provided without a value; ignoring')
        continue
      }
      const parsed = Number(next)
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed))
      } else {
        console.warn(`⚠️  Invalid --limit value "${next}"; ignoring`)
      }
      i++
      continue
    }

    const limitMatch = arg.match(/^--limit=(.+)$/)
    if (limitMatch) {
      const parsed = Number(limitMatch[1])
      if (Number.isFinite(parsed)) {
        opts.limit = Math.max(1, Math.floor(parsed))
      } else {
        console.warn(`⚠️  Invalid --limit value "${limitMatch[1]}"; ignoring`)
      }
      continue
    }
  }

  return opts
}
