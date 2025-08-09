import { pathToFileURL } from 'url'
import { query } from '../lib/db'

async function run() {
  await query(`delete from cluster_scores`)
  await query(`
    insert into cluster_scores (cluster_id, lead_article_id, size, score, why)
    with items as (
      select ac.cluster_id, a.id as article_id, a.published_at, s.weight
      from article_clusters ac
      join articles a on a.id = ac.article_id
      join sources s on s.id = a.source_id
      where a.published_at > now() - interval '7 days'
    ),
    lead as (
      select cluster_id,
             (array_agg(article_id order by published_at desc))[1] as lead_article_id,
             max(published_at) as lead_time,
             count(*) as size,
             avg(weight) as avg_weight
      from items
      group by cluster_id
    )
    select l.cluster_id, l.lead_article_id, l.size,
           (0.6 * exp(-extract(epoch from (now() - l.lead_time))/28800.0)
            + 0.25 * l.avg_weight
            + 0.15 * ln(1 + l.size)) as score,
           'freshness + avg source weight + size' as why
    from lead l
    order by score desc;
  `)
  console.log('Rescored.')
}

// ESM-safe launcher
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (isMain) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}

export { run }
