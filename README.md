# Climate River

Minimal, fast climate news river. Next.js (App Router) + Tailwind + Postgres (Supabase).

## Pipeline Architecture

Climate River uses a multi-stage data pipeline orchestrated by two Vercel cron jobs that run at different frequencies and intensities.

### Cron Schedule Overview

```mermaid
gantt
    title Daily Cron Schedule (UTC)
    dateFormat HH
    axisFormat %H:00

    section Full Cron
    Full (5min)    :f1, 01, 1h
    Full (5min)    :f2, 10, 1h
    Full (5min)    :f3, 20, 1h

    section Refresh Cron
    Refresh (2min) :r1, 00, 1h
    Refresh (2min) :r2, 04, 1h
    Refresh (2min) :r3, 12, 1h
    Refresh (2min) :r4, 16, 1h
    Refresh (2min) :r5, 18, 1h
    Refresh (2min) :r6, 22, 1h
```

| Cron        | Schedule                                     | Timeout | Purpose                                          |
| ----------- | -------------------------------------------- | ------- | ------------------------------------------------ |
| **Full**    | 01:00, 10:00, 20:00 UTC                      | 5 min   | Comprehensive pipeline with discovery + rewrites |
| **Refresh** | 00:00, 04:00, 12:00, 16:00, 18:00, 22:00 UTC | 2 min   | Quick content refresh                            |

### Pipeline Flow

```mermaid
flowchart TB
    subgraph Sources["📡 Content Sources"]
        RSS[RSS Feeds]
        GN[Google News]
        WEB[Web Discovery<br/>Tavily + OpenAI]
    end

    subgraph Ingest["📥 Ingestion Layer"]
        direction TB
        subgraph DiscoverPath["discover.ts"]
            DISC[Google News RSS]
            DISC_KW[Keyword Clustering]
        end
        subgraph IngestPath["ingest.ts (Full Processing)"]
            ING[Feed Processing]
            EMB[Generate Embeddings<br/>text-embedding-3-small]
            SEM_CLUST[Semantic Clustering<br/>pgvector similarity]
            ING_CAT[Categorization]
        end
        subgraph WebPath["discover-web.ts"]
            WEBDISC[AI Web Search]
            WEB_KW[Keyword Clustering]
            WEB_CAT[Categorization]
        end
    end

    subgraph Backfill["🔄 Backfill Layer"]
        CAT[categorize.ts<br/>Uncategorized Articles]
        PRE[prefetch-content.ts<br/>Reader Mode Cache]
    end

    subgraph Score["📊 Scoring Layer"]
        RESCORE[rescore.ts<br/>Cluster Scoring]
        LEAD[Lead Article<br/>Selection]
    end

    subgraph Enhance["✨ Enhancement Layer"]
        REWRITE[rewrite.ts<br/>Headline Rewriting]
    end

    subgraph Storage["🗄️ Database"]
        DB[(Supabase<br/>PostgreSQL)]
    end

    GN --> DISC
    DISC --> DISC_KW
    DISC_KW --> DB

    RSS --> ING
    ING --> EMB
    EMB --> SEM_CLUST
    SEM_CLUST --> ING_CAT
    ING_CAT --> DB

    WEB --> WEBDISC
    WEBDISC --> WEB_KW
    WEB_KW --> WEB_CAT
    WEB_CAT --> DB

    DB --> CAT
    DB --> PRE
    CAT --> DB
    PRE --> DB

    DB --> RESCORE
    RESCORE --> LEAD
    LEAD --> DB

    DB --> REWRITE
    REWRITE --> DB
```

### Full Cron Pipeline

The full cron (`/api/cron/full`) runs the complete pipeline:

```mermaid
sequenceDiagram
    participant C as Cron Trigger
    participant D as discover.ts
    participant I as ingest.ts
    participant CA as categorize.ts
    participant P as prefetch-content.ts
    participant R as rescore.ts
    participant RW as rewrite.ts
    participant W as discover-web.ts
    participant DB as Database

    C->>D: 1. Discover (60 queries)
    D->>DB: Insert + keyword cluster (no categories)

    C->>I: 2. Ingest (150 articles)
    I->>DB: Insert + embed + semantic cluster + categorize

    C->>CA: 3. Categorize backfill (100 articles)
    CA->>DB: Categorize discover.ts articles

    C->>P: 4. Prefetch (50 articles)
    P->>DB: Cache content

    C->>R: 5. Rescore clusters
    R->>DB: Update scores + leads

    C->>RW: 6. Rewrite (60 headlines)
    RW->>DB: Store rewrites

    C->>W: 7. Web Discovery (heavy)
    W->>DB: Insert + keyword cluster + categorize

    C->>P: 8. Prefetch discovered
    P->>DB: Cache new content
```

### Refresh Cron Pipeline

The refresh cron (`/api/cron/refresh`) runs a lighter pipeline more frequently:

```mermaid
sequenceDiagram
    participant C as Cron Trigger
    participant I as ingest.ts
    participant CA as categorize.ts
    participant P as prefetch-content.ts
    participant R as rescore.ts
    participant W as discover-web.ts
    participant DB as Database

    C->>I: 1. Ingest (30 articles)
    I->>DB: Insert + embed + semantic cluster + categorize

    C->>CA: 2. Categorize backfill (30 articles)
    CA->>DB: Catch any uncategorized

    C->>P: 3. Prefetch (20 articles)
    P->>DB: Cache content

    C->>R: 4. Rescore clusters
    R->>DB: Update scores + leads

    Note over C,W: Only during business hours (12-22 UTC)
    C->>W: 5. Light Web Discovery
    W->>DB: Insert + keyword cluster + categorize

    C->>P: 6. Prefetch discovered
    P->>DB: Cache new content
```

### Script Details

| Script                | Purpose                 | AI Model                 | Clustering              | Categorization | Key Features                                                 |
| --------------------- | ----------------------- | ------------------------ | ----------------------- | -------------- | ------------------------------------------------------------ |
| `discover.ts`         | Google News RSS         | —                        | Keyword                 | ❌             | 14 climate queries, relevance filtering                      |
| `ingest.ts`           | RSS feed processing     | `text-embedding-3-small` | **Semantic** (pgvector) | ✅ Inline      | Full pipeline: dedup, embeddings, clustering, categorization |
| `discover-web.ts`     | AI web discovery        | `gpt-4o-mini` + Tavily   | Keyword                 | ✅ Inline      | Multi-tier search, 60+ curated outlets                       |
| `categorize.ts`       | Backfill categorization | Hybrid rules + AI        | —                       | ✅             | Catches uncategorized articles (e.g., from discover.ts)      |
| `prefetch-content.ts` | Reader mode cache       | —                        | —                       | —              | Content extraction, paywall detection                        |
| `rescore.ts`          | Cluster scoring         | —                        | —                       | —              | Freshness decay (9h half-life), velocity, coverage           |
| `rewrite.ts`          | Headline enhancement    | `gpt-4o-mini`            | —                       | —              | Techmeme-style, fact validation, no hallucinated numbers     |

**Clustering Methods:**

- **Semantic Clustering** (ingest.ts only): Uses pgvector cosine similarity on embeddings to group articles about the same story, even with different wording
- **Keyword Clustering** (discover.ts, discover-web.ts): Groups by extracted keywords from title - faster but less accurate

### Database Schema (Core Tables)

```mermaid
erDiagram
    sources ||--o{ articles : "has"
    articles ||--o{ article_clusters : "belongs to"
    clusters ||--o{ article_clusters : "contains"
    clusters ||--o| cluster_scores : "scored by"
    articles ||--o{ article_categories : "tagged with"
    categories ||--o{ article_categories : "tags"

    sources {
        bigint id PK
        text name
        text feed_url UK
        text homepage_url
        int weight
        text slug
    }

    articles {
        bigint id PK
        bigint source_id FK
        text title
        text canonical_url UK
        text dek
        timestamptz published_at
        text rewritten_title
        vector embedding
        text content_text
        text content_status
    }

    clusters {
        bigint id PK
        text key UK
        timestamptz created_at
    }

    cluster_scores {
        bigint cluster_id PK
        bigint lead_article_id FK
        int size
        float score
    }

    categories {
        int id PK
        text slug UK
        text name
    }

    article_categories {
        bigint article_id PK
        int category_id PK
        float confidence
    }
```

### Scoring Algorithm

Cluster scores determine homepage ranking using a weighted formula:

```
Score = (0.18 × coverage) + (0.05 × avg_weight) + (0.27 × ln(1 + velocity)) + (0.45 × freshness) + (0.05 × pool_strength)
```

Where:

- **Freshness**: Exponential decay with 9-hour half-life
- **Velocity**: Articles added in last 4 hours
- **Coverage**: Source diversity + total weighted coverage
- **Weight**: Source editorial weight (1-5 scale)

### Web Discovery Tiers

The `discover-web.ts` script uses a multi-tier approach:

```mermaid
flowchart LR
    subgraph "Tier 0: Broad"
        T0[Tavily Broad Search<br/>5 climate queries]
    end

    subgraph "Tier 1: Site-Specific"
        T1[Tavily Site Search<br/>60+ outlets]
    end

    subgraph "Tier 2: Fallback"
        T2[OpenAI Web Search<br/>Missing domains]
    end

    subgraph "Tier 3: RSS"
        T3[Google News RSS<br/>AI-suggested queries]
    end

    T0 --> T1
    T1 -->|"Missing domains"| T2
    T2 -->|"Still missing"| T3
```

---

**Copyright © 2025 Dylan Wahbe. All rights reserved.**

This project is **Code Available** - the source code is publicly accessible for learning and reference purposes, but is not open source software. The codebase, design, and intellectual property remain the exclusive property of Dylan Wahbe.
