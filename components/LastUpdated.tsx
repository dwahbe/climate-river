import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'

export async function getLastUpdatedDate() {
  try {
    // Get the last time articles were fetched by cron jobs
    const latest = await DB.query(`
      select coalesce(max(fetched_at), now()) as ts
      from articles
    `)
    const lastTs = latest.rows[0]?.ts ?? new Date().toISOString()
    return lastTs
  } catch (error) {
    console.error('Failed to get last updated date:', error)
    return null
  }
}

export default async function LastUpdated() {
  const lastUpdatedISO = await getLastUpdatedDate()

  // If database connection failed, don't render anything
  if (!lastUpdatedISO) {
    return null
  }

  return (
    <div className="text-xs text-zinc-500">
      Last updated <LocalTime iso={lastUpdatedISO} />
    </div>
  )
}
