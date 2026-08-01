-- "Done" (acknowledge) for SFI Leads on the Action Items tab.
--
-- Mirrors scheduler_leads.acknowledged_at: pressing Done stamps the lead so it
-- drops off the "SFI Leads" call list, without changing its lifecycle status
-- (still tracked to booking on the LeadGen page).

alter table public.leads
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references auth.users(id);
