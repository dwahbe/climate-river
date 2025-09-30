-- Add reader view content columns to articles table
ALTER TABLE articles 
  ADD COLUMN IF NOT EXISTS content_html TEXT,
  ADD COLUMN IF NOT EXISTS content_text TEXT,
  ADD COLUMN IF NOT EXISTS content_word_count INT,
  ADD COLUMN IF NOT EXISTS content_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_status TEXT,
  ADD COLUMN IF NOT EXISTS content_error TEXT;

-- Index for filtering by content status
CREATE INDEX IF NOT EXISTS idx_articles_content_status ON articles(content_status);

-- Index for cache invalidation queries
CREATE INDEX IF NOT EXISTS idx_articles_content_fetched_at ON articles(content_fetched_at) 
  WHERE content_fetched_at IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN articles.content_html IS 'Extracted article content HTML from reader view (Defuddle)';
COMMENT ON COLUMN articles.content_text IS 'Plain text version of article content';
COMMENT ON COLUMN articles.content_word_count IS 'Word count of extracted content';
COMMENT ON COLUMN articles.content_status IS 'Fetch status: success, paywall, timeout, blocked, error, or NULL if not fetched';
COMMENT ON COLUMN articles.content_error IS 'Error message if content fetch failed';

