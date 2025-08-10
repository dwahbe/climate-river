import * as sw from 'stopword'
export function stripUtm(url: string): string {
  try {
    const u = new URL(url)
    const params = new URLSearchParams(u.search)
    for (const key of Array.from(params.keys())) {
      if (
        key.startsWith('utm_') ||
        ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'refsrc'].includes(key)
      )
        params.delete(key)
    }
    u.search = params.toString()
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}
export function normalizeTitleKey(title: string): string {
  const lower = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const tokens = lower.split(/\s+/).filter(Boolean)
  const stopped = sw.removeStopwords(tokens)
  return stopped.join(' ').slice(0, 160)
}
