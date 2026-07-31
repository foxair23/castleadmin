-- LeadGen: inbound provider leads (Home Depot today, others later).
--
-- Provider emails a lead → we forward it to a Resend Inbound address → parse it
-- → auto-send the customer an email + SMS with a self-scheduling link, and track
-- the lead until it becomes a Service Fusion job (or the customer opts out / says
-- they're not interested). Leads not booked within an hour surface as an Action
-- Item so someone calls them.

-- ── Settings (single row) ────────────────────────────────────────────────────
-- Master switch defaults OFF: inbound leads are always recorded, but nothing is
-- sent to a customer until this is turned on (safety while wiring up Resend
-- Inbound + email forwarding).
create table if not exists public.leadgen_settings (
  id                int primary key default 1 check (id = 1),
  enabled           boolean not null default false,
  self_schedule_url text not null default 'sfi.cstle.co',
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id)
);
insert into public.leadgen_settings (id) values (1) on conflict (id) do nothing;

-- ── Leads ────────────────────────────────────────────────────────────────────
create table if not exists public.leads (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null default 'home_depot',
  external_id             text,                       -- e.g. HD "Service Center ID"
  -- Parsed customer details
  customer_name           text,
  greeting_name           text,                       -- first name for the greeting
  phone_raw               text,
  phone_e164              text,
  email                   text,
  address_street          text,
  address_city            text,
  address_state           text,
  address_postal          text,
  program_name            text,                       -- HD "Program Name"
  source                  text,                       -- HD "Source"
  referral_store          text,
  lead_notes              text,
  -- Raw + dedupe
  raw_email               text,
  content_hash            text unique,                -- exact re-forward guard
  received_at             timestamptz not null default now(),
  -- Lifecycle
  status                  text not null default 'new'
    check (status in ('new','held','contacted','no_contact','callback','not_interested','booked','duplicate')),
  held_reason             text,
  -- Outbound tracking
  email_sent_at           timestamptz,
  email_message_id        text,
  sms_sent_at             timestamptz,
  sms_message_id          text,
  sms_status              text,                       -- 'sent' | 'failed'
  send_error              text,
  -- Inbound reply (1 = callback, 2 = not interested)
  reply_text              text,
  replied_at              timestamptz,
  -- Conversion
  matched_job_id          text,                       -- sf_jobs.id once booked
  converted_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_leads_status      on public.leads(status);
create index if not exists idx_leads_received_at  on public.leads(received_at desc);
create index if not exists idx_leads_phone        on public.leads(phone_e164);
create index if not exists idx_leads_email        on public.leads(lower(email));
create index if not exists idx_leads_matched_job  on public.leads(matched_job_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Server code uses the service role (bypasses RLS); these policies are
-- defense-in-depth for any direct client reads. Admin + sales may view/manage.
alter table public.leadgen_settings enable row level security;
alter table public.leads            enable row level security;

drop policy if exists "staff_all_leadgen_settings" on public.leadgen_settings;
create policy "staff_all_leadgen_settings" on public.leadgen_settings for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','sales')));

drop policy if exists "staff_all_leads" on public.leads;
create policy "staff_all_leads" on public.leads for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','sales')));
