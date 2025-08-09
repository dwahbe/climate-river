# Climate River MVP

**Zero-config local run (with Supabase or any Postgres):**
```bash
npm install
export DATABASE_URL="postgres://postgres:YOURPASSWORD@db.xxxxx.supabase.co:5432/postgres?sslmode=require"
npm run ingest
npm run dev
# open http://localhost:3000/river
```

- Short feeds: Carbon Brief + Grist
- Auto schema on first ingest (no manual SQL)
- Title-based clustering (fuzzy) + fallback
- Tagging (Policy, Science, Energy, Finance, Impacts, Adaptation, Justice)
- Vercel-ready later (just set DATABASE_URL in Vercel)

Tips:
- Use `LIMIT_SOURCES=carbon-brief,grist` to keep ingest fast.
- Re-score anytime: `npm run rescore`.
