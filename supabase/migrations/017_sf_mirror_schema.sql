-- ============================================================
-- Castle Garage Doors & Gates
-- Migration 017 — Full Service Fusion Mirror Schema
-- ============================================================
-- Creates the complete sf_* mirror table set for the daily
-- Service Fusion data warehouse (PRD §3).
--
-- Renames Phase 1 ref tables:
--   sf_job_statuses_ref  → sf_job_statuses
--   sf_job_categories_ref → sf_job_categories
-- and migrates their data.
--
-- Phase 1 _cache tables (sf_customers_cache, sf_jobs_cache, etc.)
-- are NOT dropped here. They are retired in migration 018 after
-- the Phase 1 dashboard is re-pointed to the full mirror tables.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- Reference / small tables (fully re-pulled every day)
-- ─────────────────────────────────────────────────────────────

-- Job statuses
-- Replaces sf_job_statuses_ref (fields: id, code, name, is_custom, category)
create table if not exists public.sf_job_statuses (
  id               text primary key,
  code             text,
  name             text not null,
  is_custom        boolean not null default false,
  category         text,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);

-- Migrate existing ref data
insert into public.sf_job_statuses (id, name, category, sf_synced_at, sf_first_seen_at)
select id, name, category, synced_at, synced_at
from public.sf_job_statuses_ref
on conflict (id) do nothing;


-- Job categories
-- Replaces sf_job_categories_ref (fields: id, name)
create table if not exists public.sf_job_categories (
  id               text primary key,
  name             text not null,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);

insert into public.sf_job_categories (id, name, sf_synced_at, sf_first_seen_at)
select id, name, synced_at, synced_at
from public.sf_job_categories_ref
on conflict (id) do nothing;


-- Payment types (fields: id, code, short_name, type, is_custom)
create table if not exists public.sf_payment_types (
  id               text primary key,
  code             text,
  short_name       text,
  type             text,
  is_custom        boolean not null default false,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);


-- Sources / lead sources (fields: id, short_name, long_name)
create table if not exists public.sf_sources (
  id               text primary key,
  short_name       text,
  long_name        text,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);


-- Technicians
create table if not exists public.sf_techs (
  id                          text primary key,
  first_name                  text,
  last_name                   text,
  email                       text,
  phone_1                     text,
  phone_2                     text,
  color_code                  text,
  department                  text,
  title                       text,
  is_field_worker             boolean not null default true,
  is_sales_rep                boolean not null default false,
  created_at_sf               timestamptz,
  updated_at_sf               timestamptz,
  raw_data                    jsonb not null default '{}'::jsonb,
  sf_synced_at                timestamptz not null default now(),
  sf_first_seen_at            timestamptz not null default now(),
  is_deleted                  boolean not null default false
);


-- ─────────────────────────────────────────────────────────────
-- Company (single record from GET /me)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_company (
  id               text primary key,
  name             text,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────
-- Calendar tasks
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_calendar_tasks (
  id               text primary key,
  type             text,
  description      text,
  start_date       date,
  end_date         date,
  start_time       text,
  end_time         text,
  is_completed     boolean not null default false,
  is_public        boolean not null default false,
  users_id         text,
  jobs_id          text,
  estimates_id     text,
  created_at_sf    timestamptz,
  updated_at_sf    timestamptz,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);


-- ─────────────────────────────────────────────────────────────
-- Customers and child tables
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_customers (
  id                   text primary key,
  customer_name        text,
  fully_qualified_name text,
  account_number       text,
  -- §3.2.1 — account_balance is a required typed column
  account_balance      numeric(12,2),
  payment_terms        text,
  referral_source      text,
  last_serviced_date   date,
  is_vip               boolean not null default false,
  is_taxable           boolean not null default true,
  created_at_sf        timestamptz,
  updated_at_sf        timestamptz,
  raw_data             jsonb not null default '{}'::jsonb,
  sf_synced_at         timestamptz not null default now(),
  sf_first_seen_at     timestamptz not null default now(),
  is_deleted           boolean not null default false
);

-- Customer contacts (expanded via contacts, contacts.phones, contacts.emails)
create table if not exists public.sf_customer_contacts (
  id           text primary key,
  customer_id  text not null references public.sf_customers(id) on delete cascade,
  first_name   text,
  last_name    text,
  is_primary   boolean not null default false,
  raw_data     jsonb not null default '{}'::jsonb,
  sf_synced_at timestamptz not null default now()
);

-- Contact emails (child of sf_customer_contacts)
create table if not exists public.sf_contact_emails (
  id         uuid primary key default gen_random_uuid(),
  contact_id text not null references public.sf_customer_contacts(id) on delete cascade,
  email      text,
  is_primary boolean not null default false,
  raw_data   jsonb not null default '{}'::jsonb
);

-- Contact phones (child of sf_customer_contacts)
create table if not exists public.sf_contact_phones (
  id         uuid primary key default gen_random_uuid(),
  contact_id text not null references public.sf_customer_contacts(id) on delete cascade,
  phone      text,
  type       text,
  is_primary boolean not null default false,
  raw_data   jsonb not null default '{}'::jsonb
);

-- Customer locations (expanded via locations)
create table if not exists public.sf_customer_locations (
  id           text primary key,
  customer_id  text not null references public.sf_customers(id) on delete cascade,
  street_1     text,
  street_2     text,
  city         text,
  state_prov   text,
  postal_code  text,
  is_primary   boolean not null default false,
  raw_data     jsonb not null default '{}'::jsonb,
  sf_synced_at timestamptz not null default now()
);

-- Customer equipment
-- Known Issue: no top-level /equipment endpoint.
-- Must be fetched via GET /customers/{id}/equipment per customer.
-- Refreshed during weekly reconcile (all customers) and during daily
-- incremental when a customer record itself was updated.
create table if not exists public.sf_customer_equipment (
  id                         text primary key,
  customer_id                text not null references public.sf_customers(id) on delete cascade,
  type                       text,
  make                       text,
  model                      text,
  sku                        text,
  serial_number              text,
  location                   text,
  notes                      text,
  is_extended_warranty       boolean not null default false,
  extended_warranty_provider text,
  extended_warranty_date     date,
  warranty_date              date,
  install_date               date,
  created_at_sf              timestamptz,
  updated_at_sf              timestamptz,
  raw_data                   jsonb not null default '{}'::jsonb,
  sf_synced_at               timestamptz not null default now(),
  sf_first_seen_at           timestamptz not null default now(),
  is_deleted                 boolean not null default false
);


-- ─────────────────────────────────────────────────────────────
-- Jobs and child tables
-- Known Issue: every /jobs request MUST include a sort parameter.
-- The sync engine enforces sort=-start_date at the client layer.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_jobs (
  id                      text primary key,
  number                  text,
  customer_id             text,
  customer_name           text,
  status                  text,
  sub_status              text,
  category                text,
  source                  text,
  -- Dates
  start_date              date,
  end_date                date,
  closed_at               timestamptz,
  created_at_sf           timestamptz,
  updated_at_sf           timestamptz,
  -- Contact / address on the job
  contact_first_name      text,
  contact_last_name       text,
  street_1                text,
  street_2                text,
  city                    text,
  state_prov              text,
  postal_code             text,
  -- §3.2.1 — money fields required as typed, indexed columns
  payment_status          text,
  total                   numeric(12,2),
  due_total               numeric(12,2),
  payments_deposits_total numeric(12,2),
  cost_total              numeric(12,2),
  taxes_fees_total        numeric(12,2),
  drive_labor_total       numeric(12,2),
  billable_expenses_total numeric(12,2),
  -- Other
  payment_type            text,
  customer_payment_terms  text,
  is_requires_follow_up   boolean not null default false,
  description             text,
  tech_notes              text,
  completion_notes        text,
  note_to_customer        text,
  -- Full original JSON (nothing is ever discarded)
  raw_data                jsonb not null default '{}'::jsonb,
  sf_synced_at            timestamptz not null default now(),
  sf_first_seen_at        timestamptz not null default now(),
  is_deleted              boolean not null default false
);

-- Job ↔ tech assignments (expanded via techs_assigned)
create table if not exists public.sf_job_techs (
  id             uuid primary key default gen_random_uuid(),
  job_id         text not null references public.sf_jobs(id) on delete cascade,
  tech_id        text not null,
  tech_first_name text,
  tech_last_name  text,
  sf_synced_at   timestamptz not null default now(),
  unique (job_id, tech_id)
);

-- Individual payments on a job (expanded via payments)
-- §3.2.1 — payment history must be queryable, not just a running total
create table if not exists public.sf_job_payments (
  id           uuid primary key default gen_random_uuid(),
  job_id       text not null references public.sf_jobs(id) on delete cascade,
  sf_id        text,        -- SF's own payment ID, if present in response
  amount       numeric(12,2),
  payment_date date,
  payment_type text,
  raw_data     jsonb not null default '{}'::jsonb,
  sf_synced_at timestamptz not null default now(),
  unique (job_id, sf_id) -- deduplicate when sf_id is known
    deferrable initially deferred
);


-- ─────────────────────────────────────────────────────────────
-- Estimates
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_estimates (
  id                  text primary key,
  number              text,
  customer_id         text,
  customer_name       text,
  status              text,
  sub_status          text,
  category            text,
  source              text,
  start_date          date,
  created_at_sf       timestamptz,
  updated_at_sf       timestamptz,
  contact_first_name  text,
  contact_last_name   text,
  street_1            text,
  city                text,
  state_prov          text,
  postal_code         text,
  -- §3.2.1
  payment_status      text,
  total               numeric(12,2),
  due_total           numeric(12,2),
  cost_total          numeric(12,2),
  taxes_fees_total    numeric(12,2),
  opportunity_rating  text,
  raw_data            jsonb not null default '{}'::jsonb,
  sf_synced_at        timestamptz not null default now(),
  sf_first_seen_at    timestamptz not null default now(),
  is_deleted          boolean not null default false
);


-- ─────────────────────────────────────────────────────────────
-- Invoices and line items
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_invoices (
  id               text primary key,
  -- job_id tracked when synced via job expand=invoices
  job_id           text,
  customer_id      text,
  number           text,
  -- §3.2.1 — is_paid, total, date, payment_terms, mail_send_date required as typed columns
  total            numeric(12,2),
  is_paid          boolean not null default false,
  date             date,
  mail_send_date   date,
  payment_terms    text,
  created_at_sf    timestamptz,
  updated_at_sf    timestamptz,
  raw_data         jsonb not null default '{}'::jsonb,
  sf_synced_at     timestamptz not null default now(),
  sf_first_seen_at timestamptz not null default now(),
  is_deleted       boolean not null default false
);

-- Invoice line items
create table if not exists public.sf_invoice_line_items (
  id         uuid primary key default gen_random_uuid(),
  invoice_id text not null references public.sf_invoices(id) on delete cascade,
  name       text,
  description text,
  quantity   numeric(10,4),
  unit_price numeric(12,2),
  total      numeric(12,2),
  raw_data   jsonb not null default '{}'::jsonb,
  sf_synced_at timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────
-- Sync observability
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sf_sync_runs (
  id               uuid primary key default gen_random_uuid(),
  -- run_type: 'backfill' | 'incremental' | 'reconcile' | 'reference'
  run_type         text not null,
  entity           text not null,
  -- status: 'running' | 'completed' | 'failed' | 'partial'
  status           text not null default 'running',
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  records_fetched  int not null default 0,
  records_upserted int not null default 0,
  pages_fetched    int not null default 0,
  -- last_page: persisted so an interrupted backfill can resume
  last_page        int,
  error_message    text,
  meta             jsonb
);


-- ─────────────────────────────────────────────────────────────
-- Mailchimp push log
-- ─────────────────────────────────────────────────────────────
create table if not exists public.mailchimp_push_log (
  id              uuid primary key default gen_random_uuid(),
  pushed_at       timestamptz not null default now(),
  tag             text not null,
  filter_criteria jsonb,
  contact_count   int not null default 0,
  added_count     int not null default 0,
  updated_count   int not null default 0,
  skipped_count   int not null default 0,
  failed_count    int not null default 0,
  contact_results jsonb,
  created_by      uuid references auth.users(id)
);


-- ─────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────

-- sf_customers
create index if not exists idx_sf_customers_updated      on public.sf_customers(updated_at_sf);
create index if not exists idx_sf_customers_last_service on public.sf_customers(last_serviced_date);
create index if not exists idx_sf_customers_balance      on public.sf_customers(account_balance);
create index if not exists idx_sf_customers_referral     on public.sf_customers(referral_source);
create index if not exists idx_sf_customers_deleted      on public.sf_customers(is_deleted);

-- sf_customer_contacts / emails / phones
create index if not exists idx_sf_contacts_customer       on public.sf_customer_contacts(customer_id);
create index if not exists idx_sf_contact_emails_contact  on public.sf_contact_emails(contact_id);
create index if not exists idx_sf_contact_phones_contact  on public.sf_contact_phones(contact_id);

-- sf_customer_locations / equipment
create index if not exists idx_sf_locations_customer  on public.sf_customer_locations(customer_id);
create index if not exists idx_sf_equipment_customer  on public.sf_customer_equipment(customer_id);
create index if not exists idx_sf_equipment_updated   on public.sf_customer_equipment(updated_at_sf);

-- sf_calendar_tasks
create index if not exists idx_sf_calendar_tasks_start on public.sf_calendar_tasks(start_date);
create index if not exists idx_sf_calendar_tasks_job   on public.sf_calendar_tasks(jobs_id);
create index if not exists idx_sf_calendar_tasks_updated on public.sf_calendar_tasks(updated_at_sf);

-- sf_jobs
create index if not exists idx_sf_jobs_customer       on public.sf_jobs(customer_id);
create index if not exists idx_sf_jobs_status         on public.sf_jobs(status);
create index if not exists idx_sf_jobs_start_date     on public.sf_jobs(start_date);
create index if not exists idx_sf_jobs_closed_at      on public.sf_jobs(closed_at);
create index if not exists idx_sf_jobs_updated        on public.sf_jobs(updated_at_sf);
create index if not exists idx_sf_jobs_payment_status on public.sf_jobs(payment_status);
create index if not exists idx_sf_jobs_due_total      on public.sf_jobs(due_total);
-- Partial index: only jobs needing follow-up (Alert 4)
create index if not exists idx_sf_jobs_follow_up      on public.sf_jobs(is_requires_follow_up)
  where is_requires_follow_up = true;
create index if not exists idx_sf_jobs_deleted        on public.sf_jobs(is_deleted);

-- sf_job_techs
create index if not exists idx_sf_job_techs_job  on public.sf_job_techs(job_id);
create index if not exists idx_sf_job_techs_tech on public.sf_job_techs(tech_id);

-- sf_job_payments
create index if not exists idx_sf_job_payments_job on public.sf_job_payments(job_id);

-- sf_estimates
create index if not exists idx_sf_estimates_customer on public.sf_estimates(customer_id);
create index if not exists idx_sf_estimates_status   on public.sf_estimates(status);
create index if not exists idx_sf_estimates_start    on public.sf_estimates(start_date);
create index if not exists idx_sf_estimates_updated  on public.sf_estimates(updated_at_sf);
create index if not exists idx_sf_estimates_deleted  on public.sf_estimates(is_deleted);

-- sf_invoices
create index if not exists idx_sf_invoices_job      on public.sf_invoices(job_id);
create index if not exists idx_sf_invoices_customer on public.sf_invoices(customer_id);
create index if not exists idx_sf_invoices_is_paid  on public.sf_invoices(is_paid);
create index if not exists idx_sf_invoices_date     on public.sf_invoices(date);
create index if not exists idx_sf_invoices_updated  on public.sf_invoices(updated_at_sf);

-- sf_invoice_line_items
create index if not exists idx_sf_invoice_items_invoice on public.sf_invoice_line_items(invoice_id);

-- sf_job_statuses
create index if not exists idx_sf_job_statuses_category on public.sf_job_statuses(category);

-- sf_sync_runs
create index if not exists idx_sf_sync_runs_entity_type on public.sf_sync_runs(entity, run_type);
create index if not exists idx_sf_sync_runs_started     on public.sf_sync_runs(started_at desc);
create index if not exists idx_sf_sync_runs_status      on public.sf_sync_runs(status);

-- mailchimp_push_log
create index if not exists idx_mailchimp_push_log_pushed on public.mailchimp_push_log(pushed_at desc);


-- ─────────────────────────────────────────────────────────────
-- Row-Level Security — admin-only for all mirror tables
-- ─────────────────────────────────────────────────────────────

alter table public.sf_company             enable row level security;
alter table public.sf_calendar_tasks      enable row level security;
alter table public.sf_customers           enable row level security;
alter table public.sf_customer_contacts   enable row level security;
alter table public.sf_contact_emails      enable row level security;
alter table public.sf_contact_phones      enable row level security;
alter table public.sf_customer_locations  enable row level security;
alter table public.sf_customer_equipment  enable row level security;
alter table public.sf_job_statuses        enable row level security;
alter table public.sf_job_categories      enable row level security;
alter table public.sf_payment_types       enable row level security;
alter table public.sf_sources             enable row level security;
alter table public.sf_techs               enable row level security;
alter table public.sf_jobs                enable row level security;
alter table public.sf_job_techs           enable row level security;
alter table public.sf_job_payments        enable row level security;
alter table public.sf_estimates           enable row level security;
alter table public.sf_invoices            enable row level security;
alter table public.sf_invoice_line_items  enable row level security;
alter table public.sf_sync_runs           enable row level security;
alter table public.mailchimp_push_log     enable row level security;

create policy "admin_all_sf_company"            on public.sf_company            for all using (public.is_admin());
create policy "admin_all_sf_calendar_tasks"     on public.sf_calendar_tasks     for all using (public.is_admin());
create policy "admin_all_sf_customers"          on public.sf_customers          for all using (public.is_admin());
create policy "admin_all_sf_customer_contacts"  on public.sf_customer_contacts  for all using (public.is_admin());
create policy "admin_all_sf_contact_emails"     on public.sf_contact_emails     for all using (public.is_admin());
create policy "admin_all_sf_contact_phones"     on public.sf_contact_phones     for all using (public.is_admin());
drop policy if exists "admin_all_sf_customer_locations" on public.sf_customer_locations;
create policy "admin_all_sf_customer_locations" on public.sf_customer_locations for all using (public.is_admin());
drop policy if exists "admin_all_sf_customer_equipment" on public.sf_customer_equipment;
create policy "admin_all_sf_customer_equipment" on public.sf_customer_equipment for all using (public.is_admin());
create policy "admin_all_sf_job_statuses"       on public.sf_job_statuses       for all using (public.is_admin());
create policy "admin_all_sf_job_categories"     on public.sf_job_categories     for all using (public.is_admin());
create policy "admin_all_sf_payment_types"      on public.sf_payment_types      for all using (public.is_admin());
create policy "admin_all_sf_sources"            on public.sf_sources            for all using (public.is_admin());
create policy "admin_all_sf_techs"              on public.sf_techs              for all using (public.is_admin());
create policy "admin_all_sf_jobs"               on public.sf_jobs               for all using (public.is_admin());
create policy "admin_all_sf_job_techs"          on public.sf_job_techs          for all using (public.is_admin());
create policy "admin_all_sf_job_payments"       on public.sf_job_payments       for all using (public.is_admin());
create policy "admin_all_sf_estimates"          on public.sf_estimates          for all using (public.is_admin());
create policy "admin_all_sf_invoices"           on public.sf_invoices           for all using (public.is_admin());
drop policy if exists "admin_all_sf_invoice_line_items" on public.sf_invoice_line_items;
create policy "admin_all_sf_invoice_line_items" on public.sf_invoice_line_items for all using (public.is_admin());
create policy "admin_all_sf_sync_runs"          on public.sf_sync_runs          for all using (public.is_admin());
create policy "admin_all_mailchimp_push_log"    on public.mailchimp_push_log    for all using (public.is_admin());


-- ─────────────────────────────────────────────────────────────
-- Drop old ref tables (data already migrated above)
-- ─────────────────────────────────────────────────────────────

drop table if exists public.sf_job_statuses_ref;
drop table if exists public.sf_job_categories_ref;
