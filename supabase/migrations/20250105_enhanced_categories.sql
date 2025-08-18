-- Enhanced Categories Migration v1.0
-- Adds support for category-based filtering with confidence scoring
-- SECURITY: This migration is safe to run and includes rollback protection

BEGIN;

-- Create categories table with metadata
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'), -- Only lowercase, numbers, hyphens
  name TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 100),
  description TEXT NOT NULL CHECK (length(description) > 0 AND length(description) <= 500),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'), -- Valid hex color
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create article categories table with confidence scoring
CREATE TABLE IF NOT EXISTS article_categories (
  article_id BIGINT NOT NULL,
  category_id INT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (article_id, category_id),
  CONSTRAINT fk_article_categories_article 
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
  CONSTRAINT fk_article_categories_category 
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- Insert our 8 core categories (only if they don't exist)
INSERT INTO categories (slug, name, description, color) VALUES
  ('policy', 'Policy', 'Government regulations, laws, and policy decisions', '#3B82F6'),
  ('science', 'Science', 'Research, studies, and scientific discoveries', '#10B981'),
  ('energy', 'Energy', 'Renewable energy, EVs, and energy infrastructure', '#F59E0B'),
  ('impacts', 'Impacts', 'Climate impacts and extreme weather', '#DC2626'),
  ('finance', 'Finance', 'Green finance, investments, and ESG', '#059669'),
  ('tech', 'Tech', 'Climate technology and innovation', '#8B5CF6'),
  ('justice', 'Justice', 'Environmental justice and equity', '#7C3AED'),
  ('business', 'Business', 'Corporate climate action and green business', '#0891B2')
ON CONFLICT (slug) DO NOTHING;

-- Add unique constraint for primary categories (only one primary per article)
CREATE UNIQUE INDEX IF NOT EXISTS unique_primary_per_article 
ON article_categories (article_id) WHERE is_primary = TRUE;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_article_categories_category_confidence 
ON article_categories (category_id, confidence DESC, article_id);

CREATE INDEX IF NOT EXISTS idx_article_categories_confidence 
ON article_categories (confidence DESC, article_id);

CREATE INDEX IF NOT EXISTS idx_categories_slug 
ON categories (slug);

-- Create function for category lookups
CREATE OR REPLACE FUNCTION get_articles_by_category(
  category_slug TEXT,
  min_confidence REAL DEFAULT 0.3,
  limit_count INT DEFAULT 20
) RETURNS TABLE (
  article_id BIGINT,
  confidence REAL
) AS $$
BEGIN
  -- Input validation
  IF category_slug IS NULL OR length(trim(category_slug)) = 0 THEN
    RAISE EXCEPTION 'category_slug cannot be null or empty';
  END IF;
  
  IF min_confidence < 0.0 OR min_confidence > 1.0 THEN
    RAISE EXCEPTION 'min_confidence must be between 0.0 and 1.0';
  END IF;
  
  IF limit_count < 1 OR limit_count > 1000 THEN
    RAISE EXCEPTION 'limit_count must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT 
    ac.article_id,
    ac.confidence
  FROM article_categories ac
  JOIN categories c ON c.id = ac.category_id
  WHERE c.slug = category_slug
    AND ac.confidence >= min_confidence
  ORDER BY ac.confidence DESC, ac.article_id DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at (only if they don't exist)
DROP TRIGGER IF EXISTS update_categories_updated_at ON categories;
CREATE TRIGGER update_categories_updated_at 
  BEFORE UPDATE ON categories 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_article_categories_updated_at ON article_categories;
CREATE TRIGGER update_article_categories_updated_at 
  BEFORE UPDATE ON article_categories 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Security: Enable RLS with proper policies
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_categories ENABLE ROW LEVEL SECURITY;

-- Secure policies: Only allow read access, no modifications from client
CREATE POLICY "Categories are viewable by everyone" ON categories
  FOR SELECT USING (true);

CREATE POLICY "Article categories are viewable by everyone" ON article_categories
  FOR SELECT USING (true);

-- No INSERT/UPDATE/DELETE policies - only service role can modify via direct SQL
-- This is more secure than checking auth.role() which can be spoofed

-- Add helpful comments
COMMENT ON TABLE categories IS 'Climate news categories with UI metadata';
COMMENT ON TABLE article_categories IS 'Article-to-category mappings with confidence scores';
COMMENT ON COLUMN article_categories.confidence IS 'Confidence score from 0-1 for category assignment';
COMMENT ON COLUMN article_categories.is_primary IS 'Whether this is the primary category for the article';
COMMENT ON FUNCTION get_articles_by_category IS 'Fast lookup of articles by category with confidence filtering';

-- Verify the migration
DO $$
BEGIN
  -- Check that tables were created in current schema
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = current_schema() AND table_name = 'categories'
  ) THEN
    RAISE EXCEPTION 'categories table was not created';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = current_schema() AND table_name = 'article_categories'
  ) THEN
    RAISE EXCEPTION 'article_categories table was not created';
  END IF;
  
  -- Check that categories were inserted
  IF (SELECT COUNT(*) FROM categories) < 8 THEN
    RAISE EXCEPTION 'Not all categories were inserted. Found: %', (SELECT COUNT(*) FROM categories);
  END IF;
  
  -- Check that indexes were created
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = current_schema() 
    AND tablename = 'article_categories' 
    AND indexname = 'unique_primary_per_article'
  ) THEN
    RAISE EXCEPTION 'Primary category unique index was not created';
  END IF;
  
  RAISE NOTICE 'Migration completed successfully! Created % categories', (SELECT COUNT(*) FROM categories);
END $$;

COMMIT;
