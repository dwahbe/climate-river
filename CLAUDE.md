# Climate River MVP

Climate news aggregator with AI-powered discovery, semantic clustering, and headline rewriting. Built with Next.js 16 (App Router), TypeScript, PostgreSQL (Supabase), and OpenAI.

## Domain

https://climateriver.org

## Quick Reference

```bash
bun dev              # Dev server (Turbopack default)
bun run build        # Production build (webpack; Turbopack mishandles serverExternalPackages for jsdom)
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
bun run tier-sources         # Preview source-weight changes from config/sourceTiers.ts
bun run tier-sources:apply   # Apply source-weight changes (writes to DB)
bun run migrate-weights      # Preview one-shot rescale (legacy 1–5 → 1–10)
bun run migrate-weights:apply # Apply weight rescale (idempotent: skipped if max>5)
bun run rewrite:eval # Run model comparison eval (profiles in config/evalProfiles.ts)
bun run rewrite:eval -- --sample-size 10 --profiles structured-gpt-4.1-mini
bun run rewrite:eval:report -- --out-dir tmp/rewrite-evals/<dir>  # Generate final report
bun run websearch:eval # Compare web-search prompt variants (profiles in config/webSearchProfiles.ts)
bun run websearch:eval -- --profiles gpt-4.1-mini-v1,gpt-4.1-mini-v4 --repeat 3 --skip-reachability
```

## Tech Stack

- **Runtime**: Node.js, **Bun** as package manager
- **Framework**: Next.js 16 (App Router, ISR; dev uses Turbopack, build uses webpack)
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
- **Pipeline logging** to database for health monitoring (`pipeline_runs`)
- **Source weighting**: integer 1–10 tier per outlet (`config/sourceTiers.ts` maps known domains; default 2 for unknown). Drives the editorial-quality term in cluster scoring (`scripts/rescore.ts`)
- **Engagement events**: `article_events` table records clicks (via `app/api/click/route.ts`) and is the substrate for future CTR-based ranking signals
- **Rewrite telemetry**: `rewrite_attempts` table captures every model attempt — accepted or rejected — with latency, token counts, and a structured `validation_failures.reason` for failure-mode breakdowns
- **Model eval framework**: config-driven rewrite comparison (`config/evalProfiles.ts` for profiles/pricing, `lib/evalProviders.ts` for AI SDK provider resolution)
- **Web-search model eval**: separate framework for comparing OpenAI models on the discover-web fallback prompt (`config/webSearchProfiles.ts`, `scripts/web-search-eval.ts`). Reuses production prompts and parsers; scores parse rate, domain/freshness compliance, fabrication rate, URL reachability, tool-call efficiency, and cost per valid result.

## Conventions

- Follow existing patterns; this is a MVC-ish layered architecture
- Functional React components with hooks
- Tailwind for all styling
- Minimal comments; code should be self-explanatory
- Error handling: try-catch with `error instanceof Error` type guards
- Path alias: `@/*` maps to project root
- Scripts run with `bun scripts/<name>.ts`
- No pre-commit hooks; lint/build manually before pushing
- After making changes, check if `AGENTS.md`, `CLAUDE.md`, or `README.md` need updating (e.g. new scripts, changed models, architectural shifts). Only update if actually needed.

## Environment Variables

See `.env.example` for the full list with descriptions.

**Required**: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ADMIN_TOKEN`

**Optional**: `TAVILY_API_KEY`, `WEB_SEARCH_ENABLED`, Google News localization (`DISCOVER_*`), web search tuning (`WEB_SEARCH_*`, `GOOGLE_SUGGESTION_MODEL`), schema maintenance (`SEARCH_VECTOR_BACKFILL_*`)
