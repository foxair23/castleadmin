-- Migration 015: Fix CHECK constraint and unique index for partial leads.
-- Safe to run even if 013 already ran — all operations are idempotent.

-- Fix the service_type CHECK so NULL is allowed (needed for partial leads).
-- The old inline CHECK from 012 does not allow NULL.
-- We drop any existing CHECK on service_type (whatever its name), then add the correct one.
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema    = 'public'
      AND table_name      = 'scheduler_leads'
      AND constraint_type = 'CHECK'
      AND constraint_name LIKE '%service_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.scheduler_leads DROP CONSTRAINT IF EXISTS %I', cname);
  END LOOP;
END $$;

-- Add the correct constraint (allows NULL for partial leads).
-- Use IF NOT EXISTS-equivalent via a guard to stay idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema    = 'public'
      AND table_name      = 'scheduler_leads'
      AND constraint_type = 'CHECK'
      AND constraint_name = 'scheduler_leads_service_type_check'
  ) THEN
    ALTER TABLE public.scheduler_leads
      ADD CONSTRAINT scheduler_leads_service_type_check
      CHECK (service_type IS NULL OR service_type IN ('garage_door', 'gate'));
  END IF;
END $$;

-- Unique partial index on session_id so we can do "find or create" logic.
-- Allows multiple rows with NULL session_id (full leads without a session).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_leads_session_id
  ON public.scheduler_leads (session_id)
  WHERE session_id IS NOT NULL;
