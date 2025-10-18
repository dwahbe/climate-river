-- Enable pgvector extension for semantic similarity searches
create extension if not exists vector;

create table if not exists sources (
  id serial primary key,
  slug text unique not null,
  name text not null,
  rss text not null,
  weight real not null default 1.0,
  created_at timestamptz not null default now()
);

create table if not exists articles (
  id bigserial primary key,
  source_id int not null references sources(id) on delete cascade,
  url text not null,
  canonical_url text not null,
  title text not null,
  author text,
  summary text,
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  embedding vector(1536),
  unique (canonical_url)
);

create index if not exists idx_articles_published_at on articles (published_at desc);

create table if not exists clusters (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_clusters_key on clusters (key) include (created_at);

create table if not exists article_clusters (
  cluster_id bigint references clusters(id) on delete cascade,
  article_id bigint references articles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (cluster_id, article_id)
);

create table if not exists cluster_scores (
  cluster_id bigint primary key references clusters(id) on delete cascade,
  lead_article_id bigint not null references articles(id) on delete cascade,
  size int not null,
  score real not null,
  updated_at timestamptz not null default now(),
  why text
);

create table if not exists tags (
  id serial primary key,
  slug text unique not null,
  name text not null
);

create table if not exists article_tags (
  article_id bigint references articles(id) on delete cascade,
  tag_id int references tags(id) on delete cascade,
  primary key (article_id, tag_id)
);

insert into tags (slug, name) values
 ('policy-law','Policy & Law'),
 ('science','Science'),
 ('energy','Energy Transition'),
 ('finance','Finance'),
 ('impacts','Impacts'),
 ('adaptation','Adaptation'),
 ('justice','Justice & Equity')
on conflict do nothing;

-- Categories table (for new 6-category system)
create table if not exists categories (
  id serial primary key,
  slug text unique not null,
  name text not null,
  description text,
  color text
);

create table if not exists article_categories (
  article_id bigint references articles(id) on delete cascade,
  category_id int references categories(id) on delete cascade,
  confidence real default 0.0,
  is_primary boolean default false,
  primary key (article_id, category_id)
);

create index if not exists idx_article_categories_category_id on article_categories(category_id);
create index if not exists idx_article_categories_article_id on article_categories(article_id);

-- Insert the 6 categories from lib/tagger.ts
insert into categories (slug, name, description, color) values
 ('government', 'Government', 'Government policy, regulations, and climate laws', '#3B82F6'),
 ('justice', 'Activism', 'Climate protests, rallies, strikes, and direct action by grassroots movements and activist organizations', '#EC4899'),
 ('business', 'Business', 'Corporate climate action, finance, and market trends', '#06B6D4'),
 ('impacts', 'Impacts', 'Climate effects, extreme weather, and environmental consequences', '#EF4444'),
 ('tech', 'Tech', 'Clean technology, renewables, and climate solutions', '#10B981'),
 ('research', 'Research & Innovation', 'Climate research, studies, and scientific discoveries', '#8B5CF6')
on conflict (slug) do nothing;
