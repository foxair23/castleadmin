-- ============================================================
-- Migration 039: Drop the matched_customer_id FK on google_reviews
-- ============================================================
-- sf_customers is an incomplete synced cache — many sf_jobs.customer_id values
-- have no corresponding sf_customers row. The review matcher derives
-- matched_customer_id from the matched job's customer_id, so when that customer
-- isn't present in sf_customers the UPDATE was rejected with
--   "violates foreign key constraint google_reviews_matched_customer_id_fkey"
-- and the match was silently lost (e.g. "Edward Frank" → "Frank, Edward",
-- job 1090151692 / customer 78933024, which scores 1.0 AUTO but couldn't be
-- written). Enforcing referential integrity against an incomplete cache is
-- inappropriate here, so we drop the constraint. The id is still stored, so the
-- join resolves once/if that customer later syncs into sf_customers; until then
-- the UI falls back to the matched job's customer_name.

alter table public.google_reviews
  drop constraint if exists google_reviews_matched_customer_id_fkey;

-- Keep matched_job_id's FK: matched jobs are always loaded from sf_jobs, so that
-- reference is guaranteed valid and ON DELETE SET NULL handles re-syncs safely.
