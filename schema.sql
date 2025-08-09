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
