// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
}

const MAX_CHARS = 160

// Endpoints
const BASE = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
const RESPONSES_URL = `${BASE}/responses`
const CHAT_URL = `${BASE}/chat/completions`

// Config
function getModel() {
  // Default to 4o-mini (you can override with REWRITE_MODEL in Vercel)
  return (process.env.REWRITE_MODEL || 'gpt-4o-mini').trim()
}

// Let operator pick "responses" explicitly via env, otherwise prefer Chat for stability.
function preferResponses() {
  const mode = (process.env.REWRITE_MODE || '').toLowerCase()
  return mode === 'responses'
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
- Make every word count - be precise and informative.`,
    `Original title: ${input.title}`,
  ]
  if (input.dek) lines.push(`Article summary: ${input.dek}`)
  lines.push('Output ONLY the rewritten headline (no quotes, no prefix).')
  return lines.join('\n')
}

function sanitizeHeadline(s: string) {
  let t = (s || '')
    .replace(/^[“"'\s]+|[”"'\s]+$/g, '') // strip quotes
    .replace(/\s+/g, ' ') // collapse spaces
    .trim()
  // Avoid trailing decorative punctuation
  t = t.replace(/[|•–—\-]+$/g, '').trim()
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

/* --------------------------- OpenAI integration --------------------------- */

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

type PostResult = {
  ok: boolean
  status: number
  json: any
  raw: string
  headers: Headers
}

async function post(
  url: string,
  body: any,
  abortMs = 20000
): Promise<PostResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      json: null,
      raw: 'no_api_key',
      headers: new Headers(),
    }
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), abortMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      // keep raw text
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      raw: text,
      headers: res.headers,
    }
  } finally {
    clearTimeout(t)
  }
}

function extractFromResponsesJSON(j: any): string {
  // Preferred single helper property
  if (typeof j?.output_text === 'string') return j.output_text

  // Structured content array
  const arr = j?.output?.[0]?.content
  if (Array.isArray(arr)) {
    // look for either output_text or text element
    const hit = arr.find(
      (p: any) =>
        p &&
        typeof p === 'object' &&
        (p.type === 'output_text' || p.type === 'text') &&
        typeof p.text === 'string'
    )
    if (hit?.text) return hit.text
  }

  // Nothing found
  return ''
}

function extractFromChatJSON(j: any): string {
  return j?.choices?.[0]?.message?.content ?? ''
}

async function generateWithOpenAI(
  title: string,
  dek?: string | null,
  abortMs = 20000,
  retries = 2
): Promise<{ text: string | null; model: string; notes: string }> {
  const model = getModel()
  const prompt = buildPrompt({ title, dek })

  const tryOnce = async (mode: 'responses' | 'chat'): Promise<PostResult> => {
    if (mode === 'responses') {
      // Responses API uses max_output_tokens
      return post(
        RESPONSES_URL,
        { model, input: prompt, temperature: 0.2, max_output_tokens: 120 },
        abortMs
      )
    }
    // Chat Completions uses max_tokens
    return post(
      CHAT_URL,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 120,
      },
      abortMs
    )
  }

  const mainMode: 'responses' | 'chat' = preferResponses()
    ? 'responses'
    : 'chat'
  const fallbackMode: 'responses' | 'chat' =
    mainMode === 'responses' ? 'chat' : 'responses'

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // First, try the preferred mode
      let r = await tryOnce(mainMode)

      // On error or empty, try fallback once (only on first attempt)
      if (!r.ok || (!r.json && !r.raw)) {
        const msg = r.json?.error?.message || r.raw || ''
        const retryable =
          r.status === 429 || (r.status >= 500 && r.status <= 599)
        const unsupported =
          r.status === 404 ||
          msg.toLowerCase().includes('not supported') ||
          msg.toLowerCase().includes('unknown')

        if ((unsupported || !r.ok) && attempt === 0) {
          const r2 = await tryOnce(fallbackMode)
          // use fallback if it succeeded; otherwise keep the original response for error reporting
          if (r2.ok) r = r2
          else if (r2.status) r = r2
        }

        if (!r.ok) {
          if (retryable && attempt < retries) {
            await sleep(400 * (attempt + 1) + Math.random() * 250)
            continue
          }
          return {
            text: null,
            model,
            notes: `api_error:${r.status}:${(r.json?.error?.message || r.raw || '').slice(0, 200)}`,
          }
        }
      }

      // Parse success (both APIs handled)
      let out = ''
      if (r.json && typeof r.json === 'object') {
        out =
          extractFromResponsesJSON(r.json) || extractFromChatJSON(r.json) || ''
      }

      // If JSON path yielded nothing, accept raw text bodies too
      if (!out && typeof r.raw === 'string') {
        out = r.raw.trim()
        if (out) {
          // Keep a breadcrumb for diagnostics
          return {
            text: sanitizeHeadline(out),
            model,
            notes: 'responses-string',
          }
        }
      }

      if (!out) {
        return { text: null, model, notes: `empty_output:${r.status}` }
      }

      return { text: sanitizeHeadline(String(out).trim()), model, notes: 'ok' }
    } catch (e: any) {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1) + Math.random() * 250)
        continue
      }
      return {
        text: null,
        model,
        notes: `fetch_error:${e?.message || String(e)}`,
      }
    }
  }

  return { text: null, model, notes: 'unreachable' }
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
