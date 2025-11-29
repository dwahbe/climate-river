// lib/supabase/client.ts
import { createClient } from '@supabase/supabase-js'

/**
 * Get Supabase configuration with validation
 * Only throws at runtime, not during build
 */
function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing Supabase environment variables. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env.local file.'
    )
  }

  return { supabaseUrl, supabaseAnonKey }
}

/**
 * Create a Supabase client for server-side use
 * Uses service role key if available, otherwise anon key
 */
export function createServerClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  return createClient(supabaseUrl, serviceKey || supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

