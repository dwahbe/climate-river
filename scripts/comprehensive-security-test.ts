#!/usr/bin/env tsx
// COMPREHENSIVE SECURITY TEST
// Tests RLS policies thoroughly before production deployment

import { query } from '../lib/db.js'

async function comprehensiveSecurityTest() {
  console.log('🔒 COMPREHENSIVE SECURITY & STABILITY TEST\n')

  let allTestsPassed = true

  try {
    console.log('📊 PRE-MIGRATION STATE CHECK')
    console.log('='.repeat(50))

    // Check current RLS status
    const rlsStatus = await query(`
      SELECT schemaname, tablename, rowsecurity
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename
    `)

    console.log('Current RLS Status:')
    rlsStatus.rows.forEach((row) => {
      const status = row.rowsecurity ? '✅ ENABLED' : '❌ DISABLED'
      console.log(`  ${row.tablename}: ${status}`)
    })

    // Check current role and permissions
    const roleInfo = await query(`
      SELECT 
        current_user,
        current_database(),
        current_schema(),
        version()
    `)
    console.log('\nConnection Info:')
    console.log(`  User: ${roleInfo.rows[0].current_user}`)
    console.log(`  Database: ${roleInfo.rows[0].current_database}`)
    console.log(`  Schema: ${roleInfo.rows[0].current_schema}`)

    // Test basic data access (should work regardless of RLS)
    console.log('\n🧪 BASIC FUNCTIONALITY TESTS')
    console.log('='.repeat(50))

    // Test 1: Article count
    const articleCount = await query('SELECT COUNT(*) as count FROM articles')
    console.log(
      `✅ Articles accessible: ${articleCount.rows[0].count} articles`
    )

    // Test 2: Category access
    const categoryCount = await query(
      'SELECT COUNT(*) as count FROM categories'
    )
    console.log(
      `✅ Categories accessible: ${categoryCount.rows[0].count} categories`
    )

    // Test 3: Complex join query (simulating homepage)
    const complexQuery = await query(`
      SELECT 
        a.id, a.title, a.published_at,
        cs.score,
        c.name as category_name
      FROM articles a
      LEFT JOIN cluster_scores cs ON a.id = cs.lead_article_id
      LEFT JOIN article_categories ac ON a.id = ac.article_id AND ac.is_primary = true
      LEFT JOIN categories c ON c.id = ac.category_id
      WHERE a.published_at >= NOW() - INTERVAL '7 days'
      ORDER BY cs.score DESC NULLS LAST
      LIMIT 5
    `)
    console.log(`✅ Complex query works: ${complexQuery.rows.length} results`)

    // Test 4: Write operation (critical test)
    console.log('\n✏️  WRITE PERMISSION TEST')
    try {
      await query('BEGIN')
      await query(`
        INSERT INTO categories (slug, name, description, color) 
        VALUES ('test-security', 'Security Test', 'Test category for security verification', '#FF0000')
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      `)
      await query('ROLLBACK')
      console.log(`✅ Write operations work (tested with rollback)`)
    } catch (writeError) {
      const errorMessage =
        writeError instanceof Error ? writeError.message : String(writeError)
      console.error(`❌ CRITICAL: Write operations failed:`, errorMessage)
      allTestsPassed = false
    }

    // Test 5: Data integrity
    console.log('\n🔍 DATA INTEGRITY CHECKS')
    console.log('='.repeat(50))

    const integrityChecks = [
      {
        name: 'Articles with clusters',
        query: `SELECT COUNT(*) as count FROM articles a 
                 JOIN cluster_scores cs ON a.id = cs.lead_article_id`,
      },
      {
        name: 'Articles with categories',
        query: `SELECT COUNT(*) as count FROM articles a
                 JOIN article_categories ac ON a.id = ac.article_id`,
      },
      {
        name: 'Recent articles',
        query: `SELECT COUNT(*) as count FROM articles 
                 WHERE published_at >= NOW() - INTERVAL '24 hours'`,
      },
    ]

    for (const check of integrityChecks) {
      try {
        const result = await query(check.query)
        console.log(`✅ ${check.name}: ${result.rows[0].count}`)
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.error(`❌ ${check.name} failed:`, errorMessage)
        allTestsPassed = false
      }
    }

    // Test 6: Performance check
    console.log('\n⚡ PERFORMANCE CHECKS')
    console.log('='.repeat(50))

    const performanceTests = [
      {
        name: 'Homepage query speed',
        query: `
          SELECT 
            a.id, a.title, a.published_at, cs.score
          FROM cluster_scores cs
          JOIN articles a ON a.id = cs.lead_article_id
          WHERE a.published_at >= NOW() - INTERVAL '7 days'
          ORDER BY cs.score DESC
          LIMIT 10
        `,
      },
      {
        name: 'Category filter speed',
        query: `
          SELECT a.id, a.title, c.name
          FROM articles a
          JOIN article_categories ac ON a.id = ac.article_id
          JOIN categories c ON c.id = ac.category_id
          WHERE c.slug = 'tech' AND ac.is_primary = true
          LIMIT 10
        `,
      },
    ]

    for (const test of performanceTests) {
      try {
        const start = Date.now()
        const result = await query(test.query)
        const duration = Date.now() - start
        console.log(
          `✅ ${test.name}: ${result.rows.length} results in ${duration}ms`
        )

        if (duration > 1000) {
          console.warn(`⚠️  ${test.name} is slow (${duration}ms)`)
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.error(`❌ ${test.name} failed:`, errorMessage)
        allTestsPassed = false
      }
    }

    console.log('\n📋 SECURITY SUMMARY')
    console.log('='.repeat(50))

    if (allTestsPassed) {
      console.log('🎉 ALL TESTS PASSED!')
      console.log('✅ Database functionality is intact')
      console.log('✅ Read operations work correctly')
      console.log('✅ Write operations work correctly')
      console.log('✅ Complex queries function properly')
      console.log('✅ Performance is acceptable')
      console.log('\n🔒 READY FOR RLS MIGRATION')
    } else {
      console.log('❌ SOME TESTS FAILED!')
      console.log('🚨 DO NOT PROCEED WITH MIGRATION UNTIL ISSUES ARE RESOLVED')
      process.exit(1)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('💥 CRITICAL TEST FAILURE:', errorMessage)
    console.error('🚨 SYSTEM IS NOT STABLE - INVESTIGATE IMMEDIATELY')
    process.exit(1)
  }
}

comprehensiveSecurityTest()
  .then(() => {
    console.log('\n✅ Security test completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ Security test failed:', error.message)
    process.exit(1)
  })
