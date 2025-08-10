// scripts/debug_counts.ts
import { query, endPool } from '@/lib/db'

async function main() {
  try {
    const s = await query<{ count: number }>(
      'select count(*)::int as count from sources'
    )
    const a = await query<{ count: number }>(
      'select count(*)::int as count from articles'
    )
    const c = await query<{ count: number }>(
      'select count(*)::int as count from clusters'
    )

    console.log('sources:', s.rows[0]?.count ?? 0)
    console.log('articles:', a.rows[0]?.count ?? 0)
    console.log('clusters:', c.rows[0]?.count ?? 0)
  } finally {
    await endPool() // close the pg pool for CLI usage
  }
}

// allow `tsx scripts/debug_counts.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export default main
