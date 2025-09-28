// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
}

const MAX_CHARS = 160

// Config
function getModel() {
  // Default to 4o-mini (you can override with REWRITE_MODEL in Vercel)
  return (process.env.REWRITE_MODEL || 'gpt-4o-mini').trim()
}

/* ------------------------- Prompt & validation ------------------------- */

function buildPrompt(input: { title: string; dek?: string | null }) {
  const lines = [
    'Rewrite this into a comprehensive, informative news headline that reads like a detailed summary.',
    `Requirements:
- Use present tense and active voice.
- Include: WHO (specific companies/officials/courts), WHAT (exact action/decision), WHERE (location/jurisdiction), WHEN (timeline), WHY (reasoning/context).
- For legal stories: Include court level, specific legal action, parties involved, and legal reasoning.
- For business stories: Include company names, financial figures, market impacts, and business reasoning.
- For policy stories: Include agency names, specific policies, affected parties, and implementation details.
- Structure: [Action] → [Target/Subject] → [Context/Background] → [Reasoning/Impact]
- Include specific details: exact titles, legal terms, dollar amounts, percentages, timeframes.
- Aim for ${MAX_CHARS} characters - comprehensive but focused.
- No hype, puns, rhetorical questions, or marketing language.
- Do not invent facts not in the provided text.
- Make every word count - be precise and informative.
- Do not end with a period - headlines should not have trailing punctuation.`,
    `Original title: ${input.title}`,
  ]
  if (input.dek) lines.push(`Article summary: ${input.dek}`)
  lines.push('Output ONLY the rewritten headline (no quotes, no prefix).')
  return lines.join('\n')
}

function sanitizeHeadline(s: string) {
  let t = (s || '')
    .replace(/^[""'\s]+|[""'\s]+$/g, '') // strip quotes
    .replace(/\s+/g, ' ') // collapse spaces
    .trim()
  // Remove trailing periods and other decorative punctuation
  t = t.replace(/[.|•–—\-]+$/g, '').trim()
  return t
}

function passesChecks(original: string, draft: string) {
  if (!draft) return false
  const t = sanitizeHeadline(draft)

  // More flexible length requirements for better headlines
  if (t.length < 15 || t.length > Math.min(MAX_CHARS + 20, 180)) return false

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, ' ')
      .trim()

  // Ensure it's different from original and has meaningful content
  if (!norm(t) || norm(t) === norm(original)) return false

  // Check if it has improved information density
  const originalWords = original.split(/\s+/).length
  const draftWords = t.split(/\s+/).length
  if (draftWords < originalWords * 0.8) return false // Don't make it too short

  return true
}

async function generateWithOpenAI(
  title: string,
  dek?: string | null,
  abortMs = 20000,
  retries = 2
): Promise<{ text: string | null; model: string; notes: string }> {
  const model = getModel()
  const prompt = buildPrompt({ title, dek })

  try {
    const { text } = await generateText({
      model: openai(model),
      prompt,
      temperature: 0.2,
      maxOutputTokens: 120,
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(abortMs),
    })

    const sanitized = sanitizeHeadline(text)
    return {
      text: sanitized,
      model,
      notes: 'success:ai_sdk',
    }
  } catch (error: any) {
    console.error('Error generating text with AI SDK:', error)
    return {
      text: null,
      model,
      notes: `failed:${error?.message || 'unknown_error'}`,
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
      select a.id, a.title, a.dek, a.canonical_url
      from articles a
      where a.rewritten_title is null
        and coalesce(a.published_at, now()) > now() - interval '21 days'
      order by a.fetched_at desc
      limit $1
    `,
    [limit]
  )
  return rows
}

async function processOne(r: Row) {
  const llm = await generateWithOpenAI(r.title, r.dek)
  const draft = llm.text || ''

  if (passesChecks(r.title, draft)) {
    await query(
      `update articles
         set rewritten_title = $1,
             rewritten_at   = now(),
             rewrite_model  = $2,
             rewrite_notes  = $3
       where id = $4`,
      [draft, llm.model || 'unknown', llm.notes || 'ok', r.id]
    )
    return { ok: 1, failed: 0 }
  }

  // Leave original title; just record why it failed.
  await query(
    `update articles
       set rewrite_model = $1,
           rewrite_notes = $2
     where id = $3`,
    [llm.model || 'none', llm.notes || 'no_valid_rewrite', r.id]
  )
  return { ok: 0, failed: 1 }
}

async function batch(limit = 40, concurrency = 4) {
  const rows = await fetchBatch(limit)
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
  const res = await batch(opts.limit ?? 40, 4)
  if (opts.closePool) await endPool()
  return res
}

// CLI support: `npm run rewrite`
if (import.meta.url === `file://${process.argv[1]}`) {
  run({ closePool: true })
    .then((r) => {
      console.log('rewrite results:', r)
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
