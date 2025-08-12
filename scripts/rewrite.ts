// scripts/rewrite.ts
import { query, endPool } from '@/lib/db'

type Row = {
  id: number
  title: string
  dek: string | null
  canonical_url: string
}

const MAX_CHARS = 110

const BASE = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
const RESPONSES_URL = BASE + '/responses'
const CHAT_URL = BASE + '/chat/completions'

function getModel() {
  return (process.env.REWRITE_MODEL || 'gpt-4o-mini').trim()
}
function getFallbackModel() {
  return (process.env.REWRITE_MODEL_FALLBACK || '').trim() || null
}

function buildPrompt(input: { title: string; dek?: string | null }) {
  const parts = [
    'Rewrite a neutral, factual, one-line news headline.',
    `Requirements:
- Use present tense.
- Include actor/subject, action, place/time if relevant, and one concrete number/stat if present.
- No hype, puns, rhetorical questions, or marketing language.
- Do not invent facts not in the provided text.
- <= ${MAX_CHARS} characters.`,
    `Original title: ${input.title}`,
  ]
  if (input.dek) parts.push(`Dek/summary: ${input.dek}`)
  parts.push('Output ONLY the rewritten headline (no quotes, no prefix).')
  return parts.join('\n')
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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function postJSON(
  url: string,
  body: any,
  apiKey: string,
  abortMs = 20_000
) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), abortMs)
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
    const raw = await res.text()
    let json: any = null
    try {
      json = JSON.parse(raw)
    } catch {}
    return { ok: res.ok, status: res.status, json, raw }
  } finally {
    clearTimeout(to)
  }
}

async function generateWithOpenAI(
  title: string,
  dek?: string | null,
  retries = 2
): Promise<{ text: string | null; model: string | null; notes: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return { text: null, model: null, notes: 'no_api_key' }

  const model = getModel()
  const prompt = buildPrompt({ title, dek })

  // Bodies to try (in order)
  const responsesBodyStructured = {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
    temperature: 0.2,
    max_output_tokens: 80,
  }
  const responsesBodyString = {
    model,
    input: prompt,
    temperature: 0.2,
    max_output_tokens: 80,
  }
  const chatBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    // Chat uses max_tokens (some gateways may still reject this model on Chat)
    max_tokens: 80,
  }

  const attempts: Array<{
    kind: 'responses-structured' | 'responses-string' | 'chat' | 'chat-fallback'
    url: string
    body: any
  }> = [
    {
      kind: 'responses-structured',
      url: RESPONSES_URL,
      body: responsesBodyStructured,
    },
    { kind: 'responses-string', url: RESPONSES_URL, body: responsesBodyString },
    { kind: 'chat', url: CHAT_URL, body: chatBody },
  ]

  const fallbackModel = getFallbackModel()
  if (fallbackModel) {
    attempts.push({
      kind: 'chat-fallback',
      url: CHAT_URL,
      body: { ...chatBody, model: fallbackModel },
    })
  }

  const errors: string[] = []

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    for (let retry = 0; retry <= retries; retry++) {
      const a = attempts[attempt]
      const r = await postJSON(a.url, a.body, apiKey)
      if (!r.ok) {
        const msg = r.json?.error?.message || r.raw || ''
        errors.push(`${a.kind}:${r.status}:${msg.slice(0, 120)}`)
        const retryable =
          r.status === 429 || (r.status >= 500 && r.status <= 599)
        if (retryable && retry < retries) {
          await sleep(400 * (retry + 1) + Math.random() * 250)
          continue
        }
        break // move to next attempt kind
      }

      // Parse success for both Responses and Chat
      const j = r.json
      const out =
        j?.output_text ??
        j?.output?.[0]?.content?.[0]?.text ??
        j?.choices?.[0]?.message?.content ??
        ''
      const cleaned = sanitizeHeadline(String(out || '').trim())
      return { text: cleaned, model: a.body.model || model, notes: a.kind }
    }
  }

  return { text: null, model, notes: `all_failed:${errors.join(' | ')}` }
}

/* ------------------------------- Runner -------------------------------- */

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>
) {
  const ret: R[] = new Array(items.length)
  let i = 0,
    active = 0
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

  // No valid rewrite -> record notes but don't overwrite original title
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
  let ok = 0,
    failed = 0
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

// CLI: npm run rewrite
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
