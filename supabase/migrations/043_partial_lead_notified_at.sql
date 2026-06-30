-- Delay the "Partial Lead" staff alert to a 15-minute grace window.
--
-- The partial lead row is still created immediately (so a completed booking can
-- be converted), but the alert now fires only if the booking is still
-- incomplete after 15 minutes — sent by a cron, which stamps partial_notified_at
-- so each partial is alerted at most once.

alter table public.scheduler_leads
  add column if not exists partial_notified_at timestamptz;

-- Cron scans for aged, still-partial, un-alerted leads.
create index if not exists idx_sched_leads_partial_pending
  on public.scheduler_leads (created_at)
  where is_partial = true and partial_notified_at is null;
