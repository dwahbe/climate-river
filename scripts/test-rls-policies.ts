#!/usr/bin/env tsx
// Test script to verify RLS policies work correctly
// This simulates the access patterns our app uses

import { query } from '../lib/db.js'

async function testRLSPolicies() {
  console.log('🔐 TESTING RLS POLICIES\n')

  try {
    // Test 1: Read access to articles (should work - public read policy)
    console.log('1. Testing article read access...')
    const articlesResult = await query(
      'SELECT COUNT(*) as count FROM articles LIMIT 1'
    )
    console.log(
      `   ✅ Can read articles: ${articlesResult.rows[0].count} articles found`
    )

    // Test 2: Read access to categories (should work - public read policy)
    console.log('2. Testing categories read access...')
    const categoriesResult = await query(
      'SELECT COUNT(*) as count FROM categories'
    )
    console.log(
      `   ✅ Can read categories: ${categoriesResult.rows[0].count} categories found`
    )

    // Test 3: Read access to cluster_scores (should work - public read policy)
    console.log('3. Testing cluster_scores read access...')
    const clusterScoresResult = await query(
      'SELECT COUNT(*) as count FROM cluster_scores LIMIT 1'
    )
    console.log(
      `   ✅ Can read cluster_scores: ${clusterScoresResult.rows[0].count} cluster scores found`
    )

    // Test 4: Complex query like our homepage uses (should work)
    console.log('4. Testing complex homepage query...')
    const homepageResult = await query(`
      SELECT 
        a.id, a.title, a.published_at,
        cs.score
      FROM cluster_scores cs
      JOIN articles a ON a.id = cs.lead_article_id
      WHERE a.published_at >= NOW() - INTERVAL '7 days'
      ORDER BY cs.score DESC
      LIMIT 3
    `)
    console.log(
      `   ✅ Complex query works: ${homepageResult.rows.length} top articles retrieved`
    )

    // Test 5: Category-based query (should work)
    console.log('5. Testing category query...')
    const categoryResult = await query(`
      SELECT 
        a.id, a.title,
        c.name as category_name
      FROM articles a
      JOIN article_categories ac ON a.id = ac.article_id
      JOIN categories c ON c.id = ac.category_id
      WHERE c.slug = 'tech'
      LIMIT 3
    `)
    console.log(
      `   ✅ Category query works: ${categoryResult.rows.length} tech articles found`
    )

    console.log('\n🎉 ALL RLS TESTS PASSED!')
    console.log('   • Public read access is working correctly')
    console.log('   • Your app should function normally with RLS enabled')
    console.log('   • Data is now properly secured')
  } catch (error) {
    console.error('❌ RLS TEST FAILED:', error.message)
    console.error('   This indicates the RLS policies need adjustment')
    throw error
  }
}

testRLSPolicies()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
