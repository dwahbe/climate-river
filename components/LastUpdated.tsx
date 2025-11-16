import * as DB from '@/lib/db'
import LocalTime from '@/components/LocalTime'

type LastUpdatedRow = { ts: string | Date }

export async function getLastUpdatedDate(): Promise<string | null> {
  try {
    // Get the last time articles were fetched by cron jobs
    const latest = await DB.query<LastUpdatedRow>(`
      select coalesce(max(fetched_at), now()) as ts
      from articles
    `)
    const raw = latest.rows[0]?.ts
    if (!raw) return new Date().toISOString()

    if (raw instanceof Date) {
      return raw.toISOString()
    }
    if (typeof raw === 'string') {
      return raw
    }

    return new Date().toISOString()
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
