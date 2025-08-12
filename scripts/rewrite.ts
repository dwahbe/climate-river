// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
}

const MAX_CHARS = 110

// Prefer Responses API for gpt-5-* and 4o-* models
const RESPONSES_URL =
  (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1') +
  '/responses'
const CHAT_URL =
  (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1') +
  '/chat/completions'

function getModel() {
  // Default to GPT-5 Nano per plan; can override with REWRITE_MODEL
  return (process.env.REWRITE_MODEL || 'gpt-5-nano').trim()
}

/* ------------------------- Prompt & validation ------------------------- */

function buildPrompt(input: { title: string; dek?: string | null }) {
  const lines = [
    'Rewrite a neutral, factual, one-line news headline.',
    `Requirements:
- Use present tense.
- Include actor/subject, action, place/time if relevant, and one concrete number/stat if present.
- No hype, puns, rhetorical questions, or marketing language.
- Do not invent facts not in the provided text.
- <= ${MAX_CHARS} characters.`,
    `Original title: ${input.title}`,
  ]
  if (input.dek) lines.push(`Dek/summary: ${input.dek}`)
  lines.push('Output ONLY the rewritten headline (no quotes, no prefix).')
  return lines.join('\n')
}

function sanitizeHeadline(s: string) {
  let t = (s || '')
    .replace(/^[“"'\s]+|[”"'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  t = t.replace(/[|•–—\-]+$/g, '').trim()
  return t
}

function passesChecks(original: string, draft: string) {
  if (!draft) return false
  const t = sanitizeHeadline(draft)
  if (t.length < 10 || t.length > Math.min(MAX_CHARS + 5, 140)) return false
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, ' ')
      .trim()
  if (!norm(t) || norm(t) === norm(original)) return false
  return true
}

/* --------------------------- OpenAI integration --------------------------- */

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function generateWithOpenAI(
  title: string,
  dek?: string | null,
  abortMs = 20_000,
  retries = 2
): Promise<{ text: string | null; model: string | null; notes: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return { text: null, model: null, notes: 'no_api_key' }

  const model = getModel()
  const prompt = buildPrompt({ title, dek })

  // Helper to POST
  const post = async (url: string, body: any) => {
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
        /* keep raw text for notes */
      }
      return { ok: res.ok, status: res.status, json, raw: text }
    } finally {
      clearTimeout(t)
    }
  }

  // Try Responses API first (correct for gpt-5-*, gpt-4o-* families)
  const responsesBody = {
    model,
    input: prompt,
    temperature: 0.2,
    // IMPORTANT: Responses API uses max_output_tokens (not max_tokens)
    max_output_tokens: 80,
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let r = await post(RESPONSES_URL, responsesBody)

      // If the model doesn't support /responses (or other error), fall back once to Chat
      if (!r.ok) {
        const msg = r.json?.error?.message || r.raw || ''
        const isRetryable =
          r.status === 429 || (r.status >= 500 && r.status <= 599)

        // One-time fallback to Chat Completions (uses max_tokens)
        if (
          attempt === 0 &&
          (msg.includes('not supported') ||
            msg.includes('Unknown url') ||
            msg.includes('Unsupported') ||
            r.status === 404)
        ) {
          const chatBody = {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 80,
          }
          r = await post(CHAT_URL, chatBody)
        }

        if (!r.ok) {
          if (isRetryable && attempt < retries) {
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

      // Parse Responses API success
      const j = r.json
      let out =
        j?.output_text ??
        j?.output?.[0]?.content?.[0]?.text ??
        j?.choices?.[0]?.message?.content ??
        '' // fallback path for Chat

      const cleaned = sanitizeHeadline(String(out || '').trim())
      return { text: cleaned, model, notes: 'ok' }
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

  // No valid rewrite -> do not set rewritten_title (UI falls back to original)
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
