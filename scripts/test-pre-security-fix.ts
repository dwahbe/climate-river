#!/usr/bin/env tsx
// PRE-SECURITY FIX TEST - Check current state

import { query } from '../lib/db.js'

async function testPreSecurityFix() {
  console.log('🔍 PRE-SECURITY FIX ASSESSMENT\n')

  try {
    console.log('📋 FUNCTION VULNERABILITY CHECK:')
    console.log('='.repeat(40))

    const functions = [
      'trg_source_weights_audit',
      'get_recent_articles_with_deduplication',
      'update_updated_at_column',
      'find_similar_articles',
      'get_articles_by_category',
    ]

    let vulnerableFunctions = 0

    for (const funcName of functions) {
      try {
        const funcCheck = await query(
          `
          SELECT 
            proname as name,
            prosrc LIKE '%SET search_path%' as has_search_path,
            prosecdef as is_security_definer
          FROM pg_proc 
          WHERE proname = $1
        `,
          [funcName]
        )

        if (funcCheck.rows.length > 0) {
          const func = funcCheck.rows[0]
          const isVulnerable = !func.has_search_path
          const securityType = func.is_security_definer ? 'DEFINER' : 'INVOKER'

          if (isVulnerable) {
            vulnerableFunctions++
            console.log(
              `❌ ${funcName}: VULNERABLE (${securityType}, no search_path)`
            )
          } else {
            console.log(
              `✅ ${funcName}: SECURE (${securityType}, has search_path)`
            )
          }
        } else {
          console.log(`❓ ${funcName}: NOT FOUND`)
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.log(`❌ ${funcName}: ERROR - ${errorMessage}`)
        vulnerableFunctions++
      }
    }

    console.log('\n🧩 EXTENSION CHECK:')
    console.log('='.repeat(40))

    const vectorExt = await query(`
      SELECT 
        extname as name,
        nspname as schema
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      WHERE extname = 'vector'
    `)

    if (vectorExt.rows.length > 0) {
      const ext = vectorExt.rows[0]
      if (ext.schema === 'public') {
        console.log(`⚠️  vector extension: in public schema (security concern)`)
      } else {
        console.log(`✅ vector extension: in ${ext.schema} schema (secure)`)
      }
    } else {
      console.log(`❌ vector extension: NOT FOUND`)
    }

    console.log('\n📊 SECURITY SUMMARY:')
    console.log('='.repeat(40))
    console.log(`Functions needing security fixes: ${vulnerableFunctions}`)
    console.log(
      `Vector extension in public schema: ${vectorExt.rows[0]?.schema === 'public' ? 'YES' : 'NO'}`
    )

    if (vulnerableFunctions > 0) {
      console.log('\n🚨 SECURITY VULNERABILITIES DETECTED!')
      console.log('   → Apply comprehensive security migration to fix')
    } else {
      console.log('\n✅ ALL FUNCTIONS ARE SECURE!')
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Security assessment failed:', errorMessage)
    process.exit(1)
  }
}

testPreSecurityFix()
  .then(() => process.exit(0))
  .catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Test failed:', errorMessage)
    process.exit(1)
  })
