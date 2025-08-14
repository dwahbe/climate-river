// scripts/_env.ts
import { config } from 'dotenv'

// Load .env.local first (Next-style), then .env as fallback
config({ path: '.env.local', override: false })
config({ path: '.env', override: false })

// Map other common names if needed
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_CONNECTION_STRING ||
    process.env.DATABASE_URL ||
    ''
}
