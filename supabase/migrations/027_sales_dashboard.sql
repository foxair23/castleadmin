-- ============================================================
-- Castle Garage Doors & Gates
-- Migration 027 — Sales Dashboard Schema
-- ============================================================
-- Adds:
--   • is_sales() helper function (mirrors is_admin())
--   • mc_campaigns         — tracked Mailchimp campaigns
--   • mc_tag_assignments   — standing tag → rep assignment rule
--   • mc_campaign_engagement — per-(campaign, email) open/click data
--   • mc_sync_runs         — audit trail of Mailchimp sync runs
--   • sales_pipeline_statuses  — editable pipeline stage list
--   • sales_call_dispositions  — editable call outcome list
--   • sales_leads          — one row per (customer × campaign)
--   • sales_calls          — individual call log entries
--   • sales_notes          — free-text notes on leads
--   • sales_status_history — audit trail of status changes
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- Helper: is_sales()
-- ─────────────────────────────────────────────────────────────

create or replace function public.is_sales()
returns boolean language sql security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'sales' and is_active = true
  );
$$;

revoke execute on function public.is_sales() from anon;


-- ─────────────────────────────────────────────────────────────
-- Mailchimp campaign tracking
-- ─────────────────────────────────────────────────────────────

create table if not exists public.mc_campaigns (
  id                      uuid primary key default gen_random_uuid(),
  mailchimp_campaign_id   text not null unique,
  mailchimp_audience_id   text,
  subject                 text,
  send_time               timestamptz,
  tag_name                text,          -- Castle-pushed tag this campaign was sent to
  total_recipients        int,
  total_opens             int,
  total_clicks            int,
  is_tracked              boolean not null default true,
  last_synced_at          timestamptz,
  created_at              timestamptz not null default now()
);

-- Standing rule: tag_name → assigned_to_user_id
-- When a lead is auto-created from engagement on a campaign with this tag,
-- it is automatically assigned to the specified user.
create table if not exists public.mc_tag_assignments (
  id                  uuid primary key default gen_random_uuid(),
  tag_name            text not null unique,
  assigned_to_user_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by_user_id uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Per-(campaign, email) engagement record
create table if not exists public.mc_campaign_engagement (
  id                    uuid primary key default gen_random_uuid(),
  mailchimp_campaign_id text not null references public.mc_campaigns(mailchimp_campaign_id) on delete cascade,
  email                 text not null,
  customer_id           text references public.sf_customers(id) on delete set null,
  first_opened_at       timestamptz,
  last_opened_at        timestamptz,
  open_count            int not null default 0,
  first_clicked_at      timestamptz,
  last_clicked_at       timestamptz,
  click_count           int not null default 0,
  last_synced_at        timestamptz not null default now(),
  unique (mailchimp_campaign_id, email)
);

-- Audit trail for Mailchimp sync button presses
create table if not exists public.mc_sync_runs (
  id                uuid primary key default gen_random_uuid(),
  triggered_by_user uuid references public.profiles(id) on delete set null,
  triggered_at      timestamptz not null default now(),
  campaigns_synced  int,
  new_openers       int,
  new_clickers      int,
  success           boolean not null default true,
  error_message     text
);


-- ─────────────────────────────────────────────────────────────
-- Sales pipeline configuration (admin-editable)
-- ─────────────────────────────────────────────────────────────

create table if not exists public.sales_pipeline_statuses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0,
  is_active  boolean not null default true
);

insert into public.sales_pipeline_statuses (name, sort_order) values
  ('New',         1),
  ('Contacted',   2),
  ('Engaged',     3),
  ('Quoted',      4),
  ('Closed Won',  5),
  ('Closed Lost', 6)
on conflict (name) do nothing;


create table if not exists public.sales_call_dispositions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0,
  is_active  boolean not null default true
);

insert into public.sales_call_dispositions (name, sort_order) values
  ('Connected',          1),
  ('Voicemail',          2),
  ('No Answer',          3),
  ('Bad Number',         4),
  ('Not Interested',     5),
  ('Callback Requested', 6),
  ('Quote Sent',         7),
  ('Closed Won',         8),
  ('Closed Lost',        9)
on conflict (name) do nothing;


-- ─────────────────────────────────────────────────────────────
-- Sales lead data model
-- ─────────────────────────────────────────────────────────────

create table if not exists public.sales_leads (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             text not null references public.sf_customers(id) on delete restrict,
  mailchimp_campaign_id   text not null references public.mc_campaigns(mailchimp_campaign_id) on delete restrict,
  tag_name                text,             -- denormalized from campaign for fast filtering
  status                  text not null default 'New',
  assigned_to_user_id     uuid references public.profiles(id) on delete set null,
  assigned_at             timestamptz,
  assigned_by_user_id     uuid references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  first_opened_at         timestamptz,
  last_opened_at          timestamptz,
  open_count              int not null default 0,
  first_clicked_at        timestamptz,
  last_clicked_at         timestamptz,
  click_count             int not null default 0,
  last_activity_at        timestamptz not null default now(),
  closed_at               timestamptz,
  closed_outcome          text check (closed_outcome in ('won', 'lost')),
  sf_job_created          boolean not null default false,
  sf_job_marked_created_at timestamptz,
  unique (customer_id, mailchimp_campaign_id)
);

create index if not exists sales_leads_assigned_to on public.sales_leads (assigned_to_user_id);
create index if not exists sales_leads_status on public.sales_leads (status);
create index if not exists sales_leads_last_activity on public.sales_leads (last_activity_at);


create table if not exists public.sales_calls (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.sales_leads(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete restrict,
  called_at        timestamptz not null default now(),
  disposition      text not null,
  duration_minutes int,
  notes            text,
  created_at       timestamptz not null default now()
);

create index if not exists sales_calls_lead_id on public.sales_calls (lead_id);


create table if not exists public.sales_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.sales_leads(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete restrict,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists sales_notes_lead_id on public.sales_notes (lead_id);


create table if not exists public.sales_status_history (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.sales_leads(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status   text not null,
  changed_at  timestamptz not null default now()
);

create index if not exists sales_status_history_lead_id on public.sales_status_history (lead_id);


-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────

-- Mailchimp tables: admin full access; sales read-only
alter table public.mc_campaigns           enable row level security;
alter table public.mc_tag_assignments     enable row level security;
alter table public.mc_campaign_engagement enable row level security;
alter table public.mc_sync_runs           enable row level security;

create policy "admin_all_mc_campaigns"           on public.mc_campaigns           for all using (public.is_admin());
create policy "admin_all_mc_tag_assignments"     on public.mc_tag_assignments     for all using (public.is_admin());
create policy "admin_all_mc_campaign_engagement" on public.mc_campaign_engagement for all using (public.is_admin());
create policy "admin_all_mc_sync_runs"           on public.mc_sync_runs           for all using (public.is_admin());

-- Sales users can read Mailchimp data to support the sync button and engagement panels
create policy "sales_select_mc_campaigns"           on public.mc_campaigns           for select using (public.is_sales());
create policy "sales_select_mc_campaign_engagement" on public.mc_campaign_engagement for select using (public.is_sales());
create policy "sales_select_mc_sync_runs"           on public.mc_sync_runs           for select using (public.is_sales());

-- Sales users can insert sync run records (triggered by their sync button press)
create policy "sales_insert_mc_sync_runs" on public.mc_sync_runs for insert with check (public.is_sales());


-- Pipeline configuration: admin full access; sales read-only
alter table public.sales_pipeline_statuses  enable row level security;
alter table public.sales_call_dispositions  enable row level security;

create policy "admin_all_sales_pipeline_statuses" on public.sales_pipeline_statuses for all using (public.is_admin());
create policy "admin_all_sales_call_dispositions" on public.sales_call_dispositions for all using (public.is_admin());

create policy "sales_select_sales_pipeline_statuses" on public.sales_pipeline_statuses for select using (public.is_sales());
create policy "sales_select_sales_call_dispositions" on public.sales_call_dispositions for select using (public.is_sales());


-- Sales leads: admin sees all; sales sees only their own
alter table public.sales_leads enable row level security;

create policy "admin_all_sales_leads" on public.sales_leads for all using (public.is_admin());

create policy "sales_select_own_leads" on public.sales_leads
  for select using (public.is_sales() and assigned_to_user_id = auth.uid());

create policy "sales_update_own_leads" on public.sales_leads
  for update using (public.is_sales() and assigned_to_user_id = auth.uid());


-- Sales calls: admin sees all; sales sees calls on their assigned leads
alter table public.sales_calls enable row level security;

create policy "admin_all_sales_calls" on public.sales_calls for all using (public.is_admin());

create policy "sales_select_calls_on_own_leads" on public.sales_calls
  for select using (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_calls.lead_id and assigned_to_user_id = auth.uid()
    )
  );

create policy "sales_insert_calls_on_own_leads" on public.sales_calls
  for insert with check (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_calls.lead_id and assigned_to_user_id = auth.uid()
    )
  );


-- Sales notes: admin sees all; sales sees notes on their assigned leads
alter table public.sales_notes enable row level security;

create policy "admin_all_sales_notes" on public.sales_notes for all using (public.is_admin());

create policy "sales_select_notes_on_own_leads" on public.sales_notes
  for select using (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_notes.lead_id and assigned_to_user_id = auth.uid()
    )
  );

create policy "sales_insert_notes_on_own_leads" on public.sales_notes
  for insert with check (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_notes.lead_id and assigned_to_user_id = auth.uid()
    )
  );


-- Status history: admin sees all; sales sees history on their assigned leads
alter table public.sales_status_history enable row level security;

create policy "admin_all_sales_status_history" on public.sales_status_history for all using (public.is_admin());

create policy "sales_select_history_on_own_leads" on public.sales_status_history
  for select using (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_status_history.lead_id and assigned_to_user_id = auth.uid()
    )
  );

create policy "sales_insert_history_on_own_leads" on public.sales_status_history
  for insert with check (
    public.is_sales() and exists (
      select 1 from public.sales_leads
      where id = sales_status_history.lead_id and assigned_to_user_id = auth.uid()
    )
  );
