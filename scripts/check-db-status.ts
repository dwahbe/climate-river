import { query, endPool } from '@/lib/db'

async function checkDbStatus() {
  try {
    console.log('🔍 Checking database status...')

    // Check when articles were last fetched
    const lastFetched = await query(`
      SELECT 
        MAX(fetched_at) as last_fetched,
        COUNT(*) as total_articles,
        COUNT(CASE WHEN fetched_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as articles_last_24h
      FROM articles
    `)

    const row = lastFetched.rows[0]
    console.log('📊 Article Status:')
    console.log(`  Last fetched: ${row?.last_fetched || 'Never'}`)
    console.log(`  Total articles: ${row?.total_articles || 0}`)
    console.log(`  Articles last 24h: ${row?.articles_last_24h || 0}`)

    // Check recent ingest activity
    const recentIngest = await query(`
      SELECT 
        MAX(created_at) as last_ingest,
        COUNT(*) as total_ingests
      FROM ingest_logs
    `)

    const ingestRow = recentIngest.rows[0]
    console.log('\n📥 Ingest Status:')
    console.log(`  Last ingest: ${ingestRow?.last_ingest || 'Never'}`)
    console.log(`  Total ingests: ${ingestRow?.total_ingests || 0}`)

    // Check if ingest_logs table exists
    const tableCheck = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'ingest_logs'
      ) as table_exists
    `)

    if (!tableCheck.rows[0]?.table_exists) {
      console.log('  ⚠️  ingest_logs table does not exist')
    }

    // Check current time
    const now = new Date()
    console.log(`\n🕐 Current time: ${now.toISOString()}`)

    // Check if cron jobs should have run
    const cronTimes = [6, 9, 12, 15, 18] // Your light cron schedule
    const currentHour = now.getHours()
    const nextCron = cronTimes.find((h) => h > currentHour) || cronTimes[0]

    console.log(`\n⏰ Cron Schedule:`)
    console.log(`  Light cron times: ${cronTimes.join(', ')}`)
    console.log(`  Current hour: ${currentHour}`)
    console.log(`  Next cron: ${nextCron}`)
  } catch (error) {
    console.error('❌ Error checking database status:', error)
  } finally {
    await endPool()
  }
}

checkDbStatus()
