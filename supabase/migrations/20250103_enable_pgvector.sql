-- Enable the pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to articles table
ALTER TABLE articles ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create index for vector similarity search
CREATE INDEX IF NOT EXISTS articles_embedding_idx ON articles 
USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);

-- Function to find similar articles by embedding
CREATE OR REPLACE FUNCTION find_similar_articles(
  query_embedding vector(1536),
  similarity_threshold float DEFAULT 0.8,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id bigint,
  title text,
  similarity float
)
LANGUAGE sql
AS $$
  SELECT 
    articles.id,
    articles.title,
    1 - (articles.embedding <=> query_embedding) as similarity
  FROM articles
  WHERE articles.embedding IS NOT NULL
    AND 1 - (articles.embedding <=> query_embedding) > similarity_threshold
  ORDER BY articles.embedding <=> query_embedding
  LIMIT match_count;
$$;
