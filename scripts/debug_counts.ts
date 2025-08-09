import { query, pool } from '@/lib/db'
async function main() {
  const s  = await query<{count:number}>('select count(*)::int as count from sources')
  const a  = await query<{count:number}>('select count(*)::int as count from articles')
  const c  = await query<{count:number}>('select count(*)::int as count from clusters')
  const sc = await query<{count:number}>('select count(*)::int as count from cluster_scores')
  console.log({ sources: s.rows[0]?.count, articles: a.rows[0]?.count, clusters: c.rows[0]?.count, scored: sc.rows[0]?.count })
  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
