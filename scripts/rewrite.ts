// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
}

const MAX_CHARS = 110
const OPENAI_URL =
  (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1') +
  '/chat/completions'

function getModel() {
  // Default to GPT-5 Nano per your plan; overridable via env
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
    .replace(/^[“"'\s]+|[”"'\s]+$/g, '') // strip quotes
    .replace(/\s+/g, ' ') // collapse spaces
    .trim()
  // Avoid trailing punctuation that often creeps in
  t = t.replace(/[|•–—\-]+$/g, '').trim()
  return t
}

function passesChecks(original: string, draft: string) {
  if (!draft) return false
  const t = sanitizeHeadline(draft)
  if (t.length < 10 || t.length > Math.min(MAX_CHARS + 5, 140)) return false
  // crude sameness check
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\W_]+/g, ' ')
      .trim()
  if (!norm(t) || norm(t) === norm(original)) return false
  return true
}

/** Fallback without an API key: use dek or trimmed original */
function fallbackRewrite(title: string, dek?: string | null) {
  const src = sanitizeHeadline((dek || title).slice(0, MAX_CHARS + 10))
  return src.length > MAX_CHARS ? src.slice(0, MAX_CHARS - 1) + '…' : src
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

  const body = {
    model: getModel(),
    messages: [{ role: 'user', content: buildPrompt({ title, dek }) }],
    max_tokens: 80,
    temperature: 0.2,
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), abortMs)
    try {
      const res = await fetch(OPENAI_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        // retry on 429/5xx
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          throw new Error(`retryable:${res.status}:${errText.slice(0, 120)}`)
        }
        return {
          text: null,
          model: getModel(),
          notes: `api_error:${res.status}:${errText.slice(0, 200)}`,
        }
      }

      const json = await res.json()
      const text = sanitizeHeadline(
        json?.choices?.[0]?.message?.content?.trim() || ''
      )
      return { text, model: getModel(), notes: 'ok' }
    } catch (e: any) {
      if (attempt < retries) {
        // basic backoff with jitter
        await sleep(400 * (attempt + 1) + Math.random() * 250)
        continue
      }
      return {
        text: null,
        model: getModel(),
        notes: `fetch_error:${e?.message || e}`,
      }
    } finally {
      clearTimeout(t)
    }
  }

  return { text: null, model: getModel(), notes: 'unreachable' }
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
  // Keep simple (no SKIP LOCKED transaction); safe for single cron
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
  const tryLLM = await generateWithOpenAI(r.title, r.dek)
  let final = tryLLM.text || ''
  if (!passesChecks(r.title, final)) {
    final = fallbackRewrite(r.title, r.dek)
  }

  if (passesChecks(r.title, final)) {
    await query(
      `update articles
         set rewritten_title = $1,
             rewritten_at   = now(),
             rewrite_model  = $2,
             rewrite_notes  = $3
       where id = $4`,
      [final, tryLLM.model || 'fallback', tryLLM.notes || 'fallback', r.id]
    )
    return { ok: 1, failed: 0 }
  } else {
    await query(
      `update articles
         set rewrite_model = $1,
             rewrite_notes = $2
       where id = $3`,
      [tryLLM.model || 'none', tryLLM.notes || 'invalid_draft', r.id]
    )
    return { ok: 0, failed: 1 }
  }
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
