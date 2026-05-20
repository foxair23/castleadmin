-- Migration 014: Make scheduler_leads support partial leads
-- Each statement is independent and idempotent. Run this even if 013 was run.

ALTER TABLE public.scheduler_leads ADD COLUMN IF NOT EXISTS session_id       text;
ALTER TABLE public.scheduler_leads ADD COLUMN IF NOT EXISTS is_partial       boolean NOT NULL DEFAULT false;
ALTER TABLE public.scheduler_leads ADD COLUMN IF NOT EXISTS additional_notes text;

-- Drop NOT NULL on fields that partial leads won't have yet.
-- These are no-ops if the column is already nullable.
ALTER TABLE public.scheduler_leads ALTER COLUMN customer_last_name       DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN customer_email           DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN address_line1            DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN address_city             DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN address_zip              DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN appointment_date         DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN appointment_window_start DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN appointment_window_end   DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN service_type             DROP NOT NULL;
ALTER TABLE public.scheduler_leads ALTER COLUMN service_category         DROP NOT NULL;

-- Index for filtering partial vs complete leads
CREATE INDEX IF NOT EXISTS idx_sched_leads_is_partial
  ON public.scheduler_leads (is_partial);
