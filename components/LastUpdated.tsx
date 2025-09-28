import * as DB from '@/lib/db'

export default async function LastUpdated() {
  // Get the last time articles were fetched by cron jobs
  const latest = await DB.query(`
    select coalesce(max(fetched_at), now()) as ts
    from articles
  `)
  const lastTs = latest.rows[0]?.ts ?? new Date().toISOString()
  const lastUpdatedDate = new Date(lastTs)

  return (
    <>
      {/* Desktop: Last updated in navbar */}
      <div className="text-xs text-zinc-500">
        Last updated{' '}
        {lastUpdatedDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'America/New_York',
        })}{' '}
        at{' '}
        {lastUpdatedDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: false,
          timeZone: 'America/New_York',
        })}{' '}
        ET
      </div>
    </>
  )
}
