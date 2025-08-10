import * as sw from 'stopword'

export type ArticleLike = { title: string; summary?: string | null }
const rules: Array<{ slug: string; rx: RegExp }> = [
  {
    slug: 'policy-law',
    rx: /(epa|ferc|sec|eu|parliament|regulation|rule|mandate|standard|court|lawsuit|bill|policy|permitting)/i,
  },
  {
    slug: 'science',
    rx: /(study|paper|journal|nature|science|pnas|observations|model|dataset|peer-reviewed)/i,
  },
  {
    slug: 'energy',
    rx: /(solar|wind|battery|evs?|grid|transmission|storage|renewable|hydrogen|nuclear|geothermal|heat pump)/i,
  },
  {
    slug: 'finance',
    rx: /(bank|bond|finance|investment|fund|credit|loan|insurance|insurer|ratings?)/i,
  },
  {
    slug: 'impacts',
    rx: /(heatwave|wildfire|flood|drought|hurricane|storm|sea[- ]?level|record heat|smoke|air quality)/i,
  },
  {
    slug: 'adaptation',
    rx: /(resilien(ce|t)|adaptation|retreat|floodwall|levee|cooling center|hardening)/i,
  },
  {
    slug: 'justice',
    rx: /(frontline|environmental justice|ej|indigenous|tribal|community-led|overburdened|disproportionate)/i,
  },
]
export function tagArticle(a: ArticleLike): string[] {
  const text = [a.title, a.summary].filter(Boolean).join(' ').slice(0, 1200)
  const hits = new Set<string>()
  for (const r of rules) if (r.rx.test(text)) hits.add(r.slug)
  return [...hits]
}
