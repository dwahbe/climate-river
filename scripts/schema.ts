import { query, pool } from '@/lib/db'

async function run() {
  // Ensure expected columns exist on clusters
  await query(
    `alter table if exists clusters add column if not exists key text`
  )
  await query(
    `alter table if exists clusters add column if not exists created_at timestamptz not null default now()`
  )

  // Recreate the index on key (no INCLUDE needed)
  await query(`drop index if exists idx_clusters_key`)
  await query(
    `create unique index if not exists idx_clusters_key on clusters (key)`
  )

  console.log('Schema repaired.')
  await pool.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
