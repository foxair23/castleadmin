-- LeadGen → Service Fusion customer pre-creation.
--
-- Once an SFI lead ages past the 1-hour mark (and lands on the Action Items
-- "SFI Leads" list) without being booked, we create a CUSTOMER record in
-- Service Fusion — but NOT a job — so the CS team has a profile to build the
-- job from, speeding up manual booking. Returning callers are matched to their
-- existing SF customer instead of spawning a duplicate (and their missing
-- contact info is appended). These columns record the outcome per lead so we
-- never create/link twice and can surface "Customer in SF" on the lead.

alter table public.leads
  add column if not exists sf_customer_id     text,        -- the SF customer id (created or matched)
  add column if not exists sf_customer_at     timestamptz, -- when we created/linked it
  add column if not exists sf_customer_source text
    check (sf_customer_source in ('created','linked'));     -- created a new one vs linked an existing

create index if not exists idx_leads_sf_customer on public.leads(sf_customer_id);
