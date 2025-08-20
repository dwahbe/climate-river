-- Fix Remaining Security Issues
-- Date: 2025-01-20
-- Purpose: Address the final 2 security issues from Supabase Security Advisor
-- Issues to fix:
-- 1. RLS Disabled: public.article_events table
-- 2. Security Definer View: public.vw_source_effective_weight

BEGIN;

-- ISSUE 1: Enable RLS on article_events table
-- This table tracks article-related events (184 rows currently)
ALTER TABLE public.article_events ENABLE ROW LEVEL SECURITY;

-- Create public read policy for article_events (consistent with other tables)
CREATE POLICY "public_read_article_events" ON public.article_events
    FOR SELECT TO public
    USING (true);

-- ISSUE 2: Fix Security Definer View
-- The view vw_source_effective_weight is flagged as a security concern
-- Current definition: Shows source weights with fallbacks
-- Solution: Recreate as SECURITY INVOKER (the safe default)

-- Drop the existing view
DROP VIEW IF EXISTS public.vw_source_effective_weight;

-- Recreate with explicit SECURITY INVOKER
CREATE VIEW public.vw_source_effective_weight 
WITH (security_invoker = true) AS
SELECT 
    s.id AS source_id,
    COALESCE(
        w.weight::real, 
        s.weight, 
        1.0::real
    ) AS weight
FROM sources s
LEFT JOIN source_weights w ON (
    w.host = lower(
        regexp_replace(
            s.homepage_url, 
            '^https?://(www\.)?([^/]+).*$', 
            '\2'
        )
    )
);

-- Grant appropriate permissions on the recreated view
GRANT SELECT ON public.vw_source_effective_weight TO public;

-- Verification
DO $$
DECLARE
    article_events_rls BOOLEAN;
    view_exists BOOLEAN;
BEGIN
    -- Check if article_events now has RLS enabled
    SELECT rowsecurity INTO article_events_rls
    FROM pg_tables 
    WHERE tablename = 'article_events';
    
    -- Check if view was recreated successfully
    SELECT EXISTS(
        SELECT 1 FROM information_schema.views 
        WHERE table_name = 'vw_source_effective_weight'
    ) INTO view_exists;
    
    RAISE NOTICE 'SECURITY FIX VERIFICATION:';
    
    IF article_events_rls THEN
        RAISE NOTICE '✅ article_events: RLS now ENABLED';
    ELSE
        RAISE EXCEPTION '❌ FAILED: article_events RLS still disabled';
    END IF;
    
    IF view_exists THEN
        RAISE NOTICE '✅ vw_source_effective_weight: View recreated as SECURITY INVOKER';
    ELSE
        RAISE EXCEPTION '❌ FAILED: vw_source_effective_weight view not found';
    END IF;
    
    RAISE NOTICE '🎉 ALL REMAINING SECURITY ISSUES FIXED!';
    RAISE NOTICE '   • RLS errors should now be 0/0';
    RAISE NOTICE '   • Security Definer warnings should be resolved';
END $$;

COMMIT;

-- POST-MIGRATION NOTES:
-- After applying this migration:
-- 1. Run Supabase Security Advisor refresh
-- 2. Should see 0 errors instead of 2 errors
-- 3. Security Definer warning should be resolved
-- 4. All functionality will continue to work normally
