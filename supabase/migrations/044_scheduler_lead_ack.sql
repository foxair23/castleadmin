-- Online Scheduling acknowledgement ("Done" button).
--
-- Sales reps acknowledge new scheduler leads (partial-created or synced-to-SF)
-- by clicking a "Done" button in the email notification (or in the Action Items
-- "Online Scheduling" tab). A lead is tracked as outstanding until acknowledged.

alter table public.scheduler_leads
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references public.profiles(id);

-- The Online Scheduling tab scans for unacknowledged leads.
create index if not exists idx_sched_leads_unacked
  on public.scheduler_leads (created_at)
  where acknowledged_at is null;
