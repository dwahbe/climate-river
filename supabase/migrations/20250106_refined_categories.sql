-- Migration: Refined 6-category structure
-- Date: 2025-01-06
-- Purpose: Update categories to refined 6-category structure

BEGIN;

-- First, create a mapping table for old to new categories
CREATE TEMP TABLE category_mapping (
  old_slug TEXT,
  new_slug TEXT
);

-- Insert mappings from old 8 categories to new 6 categories
INSERT INTO category_mapping (old_slug, new_slug) VALUES
  ('policy', 'government'),     -- Policy → Government
  ('science', 'research'),      -- Science → Research  
  ('energy', 'tech'),           -- Energy → Tech
  ('impacts', 'impacts'),       -- Impacts → Impacts (unchanged)
  ('finance', 'business'),      -- Finance → Business
  ('tech', 'tech'),             -- Tech → Tech (unchanged)
  ('justice', 'justice'),       -- Justice → Justice (unchanged)
  ('business', 'business');     -- Business → Business (unchanged)

-- Create a temporary table with the new mappings
CREATE TEMP TABLE new_article_categories AS
SELECT DISTINCT
  ac.article_id,
  new_cat.id as category_id,
  MAX(ac.confidence) as confidence,  -- Take highest confidence when merging
  MAX(CASE WHEN ac.is_primary THEN 1 ELSE 0 END) = 1 as is_primary,
  MIN(ac.created_at) as created_at,
  NOW() as updated_at
FROM article_categories ac
JOIN categories old_cat ON old_cat.id = ac.category_id
JOIN category_mapping cm ON old_cat.slug = cm.old_slug
JOIN categories new_cat ON new_cat.slug = cm.new_slug
GROUP BY ac.article_id, new_cat.id;

-- Clear existing article_categories
DELETE FROM article_categories;

-- Insert the new mappings
INSERT INTO article_categories (article_id, category_id, confidence, is_primary, created_at, updated_at)
SELECT article_id, category_id, confidence, FALSE, created_at, updated_at
FROM new_article_categories;

-- Recalculate is_primary for merged categories
-- Set is_primary for the highest confidence category per article
-- Using ROW_NUMBER to handle ties deterministically
WITH ranked_categories AS (
  SELECT 
    article_id,
    category_id,
    ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY confidence DESC, category_id) as rn
  FROM article_categories
)
UPDATE article_categories 
SET is_primary = (
  SELECT CASE WHEN rc.rn = 1 THEN TRUE ELSE FALSE END
  FROM ranked_categories rc
  WHERE rc.article_id = article_categories.article_id 
    AND rc.category_id = article_categories.category_id
);

-- Update categories table with new 6-category structure
-- Delete old categories that don't exist in new structure
DELETE FROM categories WHERE slug IN ('policy', 'science', 'energy', 'finance');

-- Update existing categories with new names and descriptions
UPDATE categories SET 
  name = 'Government',
  description = 'Government policy, regulations, and climate laws',
  color = '#3B82F6'
WHERE slug = 'government';

UPDATE categories SET 
  name = 'Impacts',
  description = 'Climate effects, extreme weather, and environmental consequences', 
  color = '#EF4444'
WHERE slug = 'impacts';

UPDATE categories SET
  name = 'Tech',
  description = 'Clean technology, renewables, and climate solutions',
  color = '#10B981'
WHERE slug = 'tech';

UPDATE categories SET
  name = 'Research', 
  description = 'Climate research, studies, and scientific discoveries',
  color = '#8B5CF6'
WHERE slug = 'research';

UPDATE categories SET
  name = 'Business',
  description = 'Corporate climate action, finance, and market trends',
  color = '#06B6D4'
WHERE slug = 'business';

UPDATE categories SET
  name = 'Justice',
  description = 'Environmental justice, equity, and community impacts',
  color = '#EC4899'
WHERE slug = 'justice';

-- Insert any missing categories from the new structure
INSERT INTO categories (slug, name, description, color, created_at, updated_at)
VALUES 
  ('government', 'Government', 'Government policy, regulations, and climate laws', '#3B82F6', NOW(), NOW()),
  ('impacts', 'Impacts', 'Climate effects, extreme weather, and environmental consequences', '#EF4444', NOW(), NOW()),
  ('tech', 'Tech', 'Clean technology, renewables, and climate solutions', '#10B981', NOW(), NOW()),
  ('research', 'Research', 'Climate research, studies, and scientific discoveries', '#8B5CF6', NOW(), NOW()),
  ('business', 'Business', 'Corporate climate action, finance, and market trends', '#06B6D4', NOW(), NOW()),
  ('justice', 'Justice', 'Environmental justice, equity, and community impacts', '#EC4899', NOW(), NOW())
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  color = EXCLUDED.color,
  updated_at = NOW();

-- Verification: Check final category counts
DO $$ 
DECLARE
  rec RECORD;
  cat_count INTEGER;
BEGIN
  RAISE INFO 'Migration verification:';
  RAISE INFO 'Categories count: %', (SELECT COUNT(*) FROM categories);
  RAISE INFO 'Article categories count: %', (SELECT COUNT(*) FROM article_categories);
  RAISE INFO 'Articles with primary category: %', (SELECT COUNT(*) FROM article_categories WHERE is_primary = TRUE);
  
  -- Log category distribution
  FOR rec IN 
    SELECT c.slug, c.name, COUNT(ac.article_id) as article_count
    FROM categories c 
    LEFT JOIN article_categories ac ON c.id = ac.category_id 
    GROUP BY c.id, c.slug, c.name 
    ORDER BY article_count DESC
  LOOP
    RAISE INFO 'Category %: % articles', rec.slug, rec.article_count;
  END LOOP;
  
  SELECT COUNT(*) INTO cat_count FROM categories;
  IF cat_count != 6 THEN
    RAISE EXCEPTION 'Expected 6 categories, found %', cat_count;
  END IF;
END $$;

COMMIT;
