# Climate River MVP

Climate news aggregator with AI-powered discovery, semantic clustering, and headline rewriting. Built with Next.js 16 (App Router), TypeScript, PostgreSQL (Supabase), and OpenAI.

## Domain

https://climateriver.org

## Quick Reference

```bash
bun dev              # Dev server (Turbopack default)
bun run build        # Production build (Turbopack default)
bun run lint         # ESLint
bun run format       # Prettier
bun run test         # Node.js test runner via tsx
bun run ingest       # Ingest RSS feeds
bun run rescore      # Recalculate cluster scores
bun run rewrite      # Rewrite headlines
bun scripts/rewrite.ts --dry-run --limit 10  # Dry-run (no DB writes)
bun run categorize   # Categorize articles
bun run prefetch     # Prefetch article content
bun run discover-web # Web discovery via Tavily
bun run cleanup      # Remove old articles/clusters
bun run cleanup:dry  # Dry-run cleanup (no DB writes)
bun run schema       # Init/validate DB schema
```

## Tech Stack

- **Runtime**: Node.js, **Bun** as package manager
- **Framework**: Next.js 16 (App Router, ISR, Turbopack default)
- **Language**: TypeScript 5.9 (strict mode)
- **Styling**: Tailwind CSS 4
- **Database**: PostgreSQL via Supabase (direct `pg` client, no ORM), pgvector for embeddings
- **AI**: OpenAI (embeddings, categorization, rewriting) via Vercel AI SDK
- **Search**: Tavily API for web discovery
- **Deployment**: Vercel with cron jobs
- **Testing**: Node.js native test runner (`describe`, `it`, `assert`)
- **Linting**: ESLint (flat config) + Prettier

## Project Structure

```
app/                    # Next.js App Router pages, API routes, and cron endpoints
components/             # React components
lib/                    # Core logic: models, repositories, services, DB, categorization
scripts/                # Standalone CLI pipeline scripts
config/                 # App configuration (outlet lists, etc.)
```

## Architecture

### Data Pipeline

Four-tier cron strategy orchestrated via Vercel cron jobs (see `vercel.json`):

1. **Full** (3x/day, 5min): discover + ingest + categorize + prefetch + rescore + web discovery + cluster maintenance
2. **Refresh** (6x/day, 2min): ingest + categorize + prefetch + rescore + conditional web discovery
3. **Rewrite** (16x/day, 1min): headline rewriting (gpt-4.1-mini, Techmeme-style, with retry)
4. **Cleanup** (1x/day, 1min): remove old articles and clusters

### API Authorization

All cron/admin endpoints require either:

- Vercel cron header (`x-vercel-cron: 1`)
- Bearer token or `?token=ADMIN_TOKEN` query param

### Key Patterns

- **Repository pattern** for database access (clusterRepository)
- **Service layer** for business logic (riverService, readerService, searchService)
- **Hybrid categorization**: keyword rules (tagger.ts) + AI embeddings (categorizer.ts)
- **Semantic clustering** via pgvector cosine similarity
- **Hybrid search**: full-text + semantic search with Reciprocal Rank Fusion
- **ISR** on homepage (5min revalidation)
- **Pipeline logging** to database for health monitoring

## Conventions

- Follow existing patterns; this is a MVC-ish layered architecture
- Functional React components with hooks
- Tailwind for all styling
- Minimal comments; code should be self-explanatory
- Error handling: try-catch with `error instanceof Error` type guards
- Path alias: `@/*` maps to project root
- Scripts run with `bun scripts/<name>.ts`
- No pre-commit hooks; lint/build manually before pushing
- After making changes, check if `AGENTS.md` or `README.md` need updating (e.g. new scripts, changed models, architectural shifts). Only update if actually needed.

## Environment Variables

See `.env.example` for the full list with descriptions.

**Required**: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ADMIN_TOKEN`

**Optional**: `TAVILY_API_KEY`, `WEB_SEARCH_ENABLED`, Google News localization (`DISCOVER_*`), web search tuning (`WEB_SEARCH_*`, `GOOGLE_SUGGESTION_MODEL`)
