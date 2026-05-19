-- Migration 013: Scheduler v2 — new flow schema changes
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS guards throughout)

-- ── 1. Add new columns to scheduler_leads ────────────────────────────────

ALTER TABLE public.scheduler_leads
  ADD COLUMN IF NOT EXISTS session_id       text,
  ADD COLUMN IF NOT EXISTS is_partial       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS additional_notes text;

-- ── 2. Relax NOT NULL constraints for partial leads ───────────────────────
-- Partial leads are saved after step 2 (contact) and may not have full data yet.

ALTER TABLE public.scheduler_leads
  ALTER COLUMN customer_last_name       DROP NOT NULL,
  ALTER COLUMN customer_email           DROP NOT NULL,
  ALTER COLUMN address_line1            DROP NOT NULL,
  ALTER COLUMN address_city             DROP NOT NULL,
  ALTER COLUMN address_zip              DROP NOT NULL,
  ALTER COLUMN appointment_date         DROP NOT NULL,
  ALTER COLUMN appointment_window_start DROP NOT NULL,
  ALTER COLUMN appointment_window_end   DROP NOT NULL,
  ALTER COLUMN service_type             DROP NOT NULL,
  ALTER COLUMN service_category         DROP NOT NULL;

-- ── 3. Fix service_type CHECK constraint to allow NULL ────────────────────
-- The inline CHECK created by migration 012 must be dropped and recreated.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT constraint_name INTO cname
  FROM information_schema.table_constraints
  WHERE table_schema = 'public'
    AND table_name   = 'scheduler_leads'
    AND constraint_type = 'CHECK'
    AND constraint_name LIKE '%service_type%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.scheduler_leads DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.scheduler_leads
  ADD CONSTRAINT scheduler_leads_service_type_check
  CHECK (service_type IS NULL OR service_type IN ('garage_door', 'gate'));

-- ── 4. Unique index on session_id for partial-lead upserts ───────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_leads_session_id
  ON public.scheduler_leads (session_id)
  WHERE session_id IS NOT NULL;

-- ── 5. Index for filtering partial vs complete leads ─────────────────────
CREATE INDEX IF NOT EXISTS idx_sched_leads_is_partial
  ON public.scheduler_leads (is_partial);
