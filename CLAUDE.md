# Climate River

Climate news aggregator (https://climateriver.org): AI-assisted discovery, semantic clustering, Techmeme-style headline rewriting. Next.js 16 (App Router, ISR) · TypeScript strict · Tailwind 4 · PostgreSQL/Supabase (direct `pg`, no ORM; pgvector) · OpenAI via Vercel AI SDK · Vercel crons. Bun is the package manager; tests use the Node test runner via tsx.

## Commands

```bash
bun dev                  # Dev server (Turbopack)
bun run build            # Prod build — webpack on purpose (Turbopack mishandles serverExternalPackages/jsdom)
bun run lint / format / test
bun run schema           # Apply/validate DB schema — owns ALL DDL
bun run health           # Pipeline health vs breach thresholds; --json; exits non-zero on breach
bun run snapshot         # Top/latest homepage clusters → tmp/snapshots/ (diff before/after ranking changes)

# Pipeline stages (what the crons run)
bun run ingest / categorize / prefetch / rescore / rewrite / discover-web / cleanup

# Maintenance scripts default to preview; add :apply to write (cleanup:dry is the preview)
bun run gn:backfill[:apply]        # Resolve stored news.google.com URLs → publisher URLs
bun run feeds:discover[:apply]     # Upgrade productive pseudo-feed hosts to real RSS sources
bun run language:backfill[:apply]  # Article language metadata
bun run tier-sources[:apply]       # Source weights from config/sourceTiers.ts
bun run reader:invalidate[:apply]  # Clear cached reader content dominated by link text (nav junk)

bun scripts/rewrite.ts --dry-run --limit 10   # Exercise LLM + validator with no DB writes

bun run rewrite:eval     # Rewrite-model bakeoff (config/evalProfiles.ts); rewrite:eval:report for the report
bun run websearch:eval   # Web-search prompt/model comparison (config/webSearchProfiles.ts)
```

## Layout

`app/` pages + API/cron routes · `components/` React · `lib/` core logic (db, services, repositories, shared rules) · `scripts/` CLI pipeline stages · `config/` outlets, tiers, eval profiles.

## Cron pipeline (vercel.json)

1. **full** (3×/day): discover → ingest → categorize → prefetch → cluster maintenance → web discovery → rescore → inline rewrite. Rescore runs late so new/merged clusters are scored same-run; the inline rewrite gives fresh leads headlines immediately.
2. **refresh** (6×/day): lighter full with a 105s budget.
3. **rewrite** (16×/day): sweeper for headlines the inline passes didn't reach (gpt-4.1-mini via AI Gateway, direct-OpenAI fallback on gateway errors, circuit breaker, 45s budget).
4. **cleanup** (daily) · **health** (daily; logs a `health` row, POSTs `HEALTH_ALERT_WEBHOOK_URL` on breach) · **feeds** (weekly; `discover-feeds.ts` upgrades `discover://` hosts with ≥3 articles/30d to real RSS).

Long-running scripts accept `deadlineMs`/`deadlineAt` and stop starting new work past it — cron functions must log `pipeline_runs` (status `partial` if budget ran out) rather than die at maxDuration. Preserve this when adding steps.

**Auth**: `authorized()` in `lib/cron.ts` gates every cron/admin endpoint — Bearer or `?token=` matching `CRON_SECRET`/`ADMIN_TOKEN` (constant-time). The `x-vercel-cron` header is trusted only when `CRON_SECRET` is unset; keep `CRON_SECRET` set in Vercel.

## Single sources of truth

Change the owning module, not call sites — several are pinned by parity tests:

- **Scoring**: `lib/scoring.ts` owns blend weights + freshness decay, imported by BOTH `scripts/rescore.ts` (writes `base_score`, `latest_pub`, `why`) and the `get_river_clusters` DDL in `scripts/schema.ts` (recomputes freshness at read time, windows on cluster activity rather than lead age). Velocity = distinct sources in the last 4h; novelty = small additive boost (≤ +0.03) by centroid distance from the current top clusters.
- **Headline gate**: `validateHeadline` in `lib/rewriteShared.ts`, imported by production rewrite AND the eval harness; failure reasons land in `rewrite_attempts.validation_failures`. Per-article cap: 4 validation failures (transport errors don't count); a content refetch re-opens the article.
- **Lead eligibility**: `LEAD_INELIGIBLE_SQL` in `lib/clustering.ts` — aggregator URL or suspect date (published ≈ fetched) never becomes the displayed lead. The RPC hides a cluster only when it has no eligible lead at all.
- **Dedup**: `lib/articleDedupe.ts` (same URL, or same title within 7 days), used by ingest + discover; `isExisting` hits skip re-clustering/re-categorization.
- **Aggregator hosts**: `lib/aggregators.ts` (dependency-free list + SQL regex).
- **DDL**: `scripts/schema.ts` only; per-run ensure guards in scripts are gated behind `SCHEMA_ENSURE=1`.

## Clustering

`clusters` persists `centroid`/`member_count`/`last_member_at`, refreshed incrementally (`refreshClusterCentroid`) on every assignment/merge/split and self-healed by cluster-maintenance. `findBestCluster` is one HNSW lookup plus app-side threshold/size/recency filters. Maintenance merges similar clusters (re-checking sizes per merge against `MAX_CLUSTER_SIZE`) and splits size≥20 clusters via `agglomerativeCluster`. Thresholds live in `CLUSTER_CONFIG`.

## Discovery, content, categorization

- **Google News**: `resolveGoogleNewsUrl` in `lib/googleNews.ts` (`?url=` param → legacy token → batchexecute API), SSRF-guarded via `safeFetch`. `discover.ts` resolves at insert (capped + deadline-aware); unresolved articles stay clusterable but are lead-ineligible and skipped by prefetch.
- **discover-web**: free Google News `site:` queries per outlet by default; paid OpenAI web search (`WEB_SEARCH_ENABLED=1`) and Tavily (`WEB_SEARCH_TAVILY_OUTLETS/BROAD=1`) are opt-in.
- **Categorize**: keyword rules (`lib/tagger.ts`) + embeddings (`lib/categorizer.ts`). `articles.pipeline_state` caps the stage at 3 attempts; `no_category` articles only retry after a content refetch; generated embeddings are persisted, not regenerated.
- **Language**: `franc-min`; confident non-English skipped at ingest or hidden via `language_code` (NULL stays visible).
- **Search**: hybrid full-text + semantic with Reciprocal Rank Fusion.
- **Telemetry**: `pipeline_runs`, `rewrite_attempts`, `discovery_searches` feed `bun run health`; `article_events` records clicks for future CTR ranking.

## Gotchas

- **jsdom pinned to 22.1.0**: 23+ pulls ESM-only transitives that throw `ERR_REQUIRE_ESM` on Vercel's Lambda runtime (it disables `require(esm)`), breaking every prefetch/reader call. Don't bump without verifying production prefetch.
- **jsdom selector shim required for Defuddle**: jsdom's selector engine (nwsapi) can't parse some Defuddle cleanup selectors (`header:not(:has(p + p))…`); an unshimmed throw makes Defuddle return the whole `<body>` (site chrome) as "content". `installSelectorCompat` from `lib/domSelectorCompat.ts` must be applied to every JSDOM instance handed to Defuddle; the reader's link-density gate (`blocked` over 50% link text) is the backstop.
- Build must use webpack (see Commands); dev Turbopack is fine.
- Source weights are integer 1–10 (`config/sourceTiers.ts`); `UNKNOWN_SOURCE_WEIGHT = 2` is the only fallback for unknown sources.
- Homepage freshness comes from the RPC's read-time decay (ISR 5min), not rescore cadence — don't "fix" staleness by adding rescore runs.

## Conventions

- MVC-ish layers: repositories for DB access, services for business logic; follow existing patterns
- Functional React components; Tailwind for all styling; minimal comments
- Error handling: try-catch with `error instanceof Error` guards
- `@/*` maps to project root; scripts run with `bun scripts/<name>.ts`
- No pre-commit hooks — lint/build/test manually before pushing
- After changes, update `CLAUDE.md`/`AGENTS.md` (kept identical) and `README.md` only if actually needed

## Environment

See `.env.example` for the full annotated list.
**Required**: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ADMIN_TOKEN`
**Optional**: `CRON_SECRET` (recommended), `HEALTH_ALERT_WEBHOOK_URL`, `TAVILY_API_KEY`, `WEB_SEARCH_*`, `DISCOVER_*` (GN localization + resolve cap), `SCHEMA_ENSURE`, `SEARCH_VECTOR_BACKFILL_*`
