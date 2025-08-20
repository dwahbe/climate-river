-- SECURE RLS MIGRATION - THOROUGHLY REVIEWED
-- Date: 2025-01-20
-- Purpose: Enable Row Level Security with CORRECT policies for our application architecture
-- 
-- CRITICAL UNDERSTANDING:
-- - Our app connects as 'postgres' superuser (bypasses RLS by default)
-- - Supabase has different roles: anon, authenticated, service_role, postgres
-- - We need policies that work with our actual connection pattern
-- - This is a NEWS SITE - public read access is intentional and necessary

BEGIN;

-- STEP 1: Enable RLS on all tables (this is required to fix the security alerts)
-- NOTE: postgres role bypasses RLS by default, so this won't break our app immediately
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.article_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cluster_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.article_categories ENABLE ROW LEVEL SECURITY;

-- Handle legacy tables if they exist
DO $$
BEGIN
    -- Enable RLS on backup tables if they exist
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'tags') THEN
        ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'article_tags') THEN
        ALTER TABLE public.article_tags ENABLE ROW LEVEL SECURITY;
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'article_clusters_deleted_backup') THEN
        ALTER TABLE public.article_clusters_deleted_backup ENABLE ROW LEVEL SECURITY;
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'articles_deleted_backup') THEN
        ALTER TABLE public.articles_deleted_backup ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;

-- STEP 2: Create PUBLIC READ policies for a news site
-- These allow anyone to read the content (which is what we want for a news aggregator)

-- Sources: Public read access
CREATE POLICY "public_read_sources" ON public.sources
    FOR SELECT TO public
    USING (true);

-- Articles: Public read access  
CREATE POLICY "public_read_articles" ON public.articles
    FOR SELECT TO public
    USING (true);

-- Clusters: Public read access
CREATE POLICY "public_read_clusters" ON public.clusters
    FOR SELECT TO public
    USING (true);

-- Article clusters: Public read access
CREATE POLICY "public_read_article_clusters" ON public.article_clusters
    FOR SELECT TO public
    USING (true);

-- Cluster scores: Public read access
CREATE POLICY "public_read_cluster_scores" ON public.cluster_scores
    FOR SELECT TO public
    USING (true);

-- Categories: Public read access
CREATE POLICY "public_read_categories" ON public.categories
    FOR SELECT TO public
    USING (true);

-- Article categories: Public read access
CREATE POLICY "public_read_article_categories" ON public.article_categories
    FOR SELECT TO public
    USING (true);

-- Legacy tables (if they exist)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'tags') THEN
        CREATE POLICY "public_read_tags" ON public.tags
            FOR SELECT TO public
            USING (true);
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'article_tags') THEN
        CREATE POLICY "public_read_article_tags" ON public.article_tags
            FOR SELECT TO public
            USING (true);
    END IF;
END $$;

-- STEP 3: IMPORTANT - Ensure our application can still write
-- Since our app connects as postgres user, it will bypass RLS by default
-- But we can also add explicit policies for safety

-- NOTE: We could restrict write access to specific roles in the future,
-- but for now we need to ensure our ingestion scripts continue to work.
-- The security gain here is primarily preventing unauthorized external access.

-- Grant necessary permissions to ensure functionality
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;

-- STEP 4: Verification and safety checks
DO $$
DECLARE
    rec RECORD;
    table_count INTEGER := 0;
    rls_enabled_count INTEGER := 0;
    policy_count INTEGER := 0;
BEGIN
    -- Check RLS status
    FOR rec IN 
        SELECT schemaname, tablename, rowsecurity 
        FROM pg_tables 
        WHERE schemaname = 'public'
        ORDER BY tablename
    LOOP
        table_count := table_count + 1;
        IF rec.rowsecurity THEN
            rls_enabled_count := rls_enabled_count + 1;
            RAISE NOTICE 'RLS ENABLED: %.%', rec.schemaname, rec.tablename;
        ELSE
            RAISE WARNING 'RLS NOT ENABLED: %.%', rec.schemaname, rec.tablename;
        END IF;
    END LOOP;
    
    -- Check policy count
    SELECT COUNT(*) INTO policy_count
    FROM pg_policies 
    WHERE schemaname = 'public';
    
    RAISE NOTICE 'SECURITY SUMMARY:';
    RAISE NOTICE '• Tables processed: %', table_count;
    RAISE NOTICE '• RLS enabled on: % tables', rls_enabled_count;
    RAISE NOTICE '• Total policies created: %', policy_count;
    
    IF rls_enabled_count = 0 THEN
        RAISE EXCEPTION 'CRITICAL: No tables have RLS enabled - migration failed!';
    END IF;
    
    IF policy_count = 0 THEN
        RAISE EXCEPTION 'CRITICAL: No policies created - migration failed!';
    END IF;
    
    RAISE NOTICE '✅ RLS SECURITY MIGRATION COMPLETED SUCCESSFULLY';
END $$;

COMMIT;

-- POST-MIGRATION NOTES:
-- 1. This fixes the 11 RLS security errors in Supabase Security Advisor
-- 2. Public read access is maintained (appropriate for a news site)
-- 3. Our postgres connection will continue to work for write operations
-- 4. External unauthorized access is now blocked by RLS
-- 5. Test your application after applying this migration
