-- Vendor payment-remittance → Service Fusion payment application.
--
-- Vendors (Clopay, Overhead Door) email daily remittances to a Castle inbox
-- (Resend Inbound). We parse the line items, match each to an SF job by PO
-- number (Clopay also validates the customer name), and apply the payment onto
-- the job — recording every step so nothing moves to the wrong place. Each
-- remittance email is one audit record with its full raw copy retained.

-- Fast, exact PO lookups: PO lives only inside sf_jobs.raw_data today (unindexed
-- JSON). Surface it as a stored generated column + index. NOTE: a job may list
-- several POs separated by ; or / — matching splits on those and checks
-- membership, so this column holds the raw string.
alter table public.sf_jobs
  add column if not exists po_number text generated always as (raw_data->>'po_number') stored;
create index if not exists idx_sf_jobs_po_number on public.sf_jobs (po_number);

-- ── Vendors (config + per-vendor autopilot) ─────────────────────────────────
create table if not exists public.remittance_vendors (
  id             text primary key,                 -- 'clopay' | 'overhead_door'
  name           text not null,
  from_pattern   text not null,                    -- sender-domain match (e.g. 'clopay.com')
  match_strategy text not null,                    -- 'po_then_name' | 'po'
  autopilot      boolean not null default false,   -- auto-apply confident matches (per vendor)
  enabled        boolean not null default true,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);
insert into public.remittance_vendors (id, name, from_pattern, match_strategy) values
  ('clopay',        'Clopay',        'clopay.com',       'po_then_name'),
  ('overhead_door', 'Overhead Door', 'overheaddoor.com', 'po')
on conflict (id) do nothing;

-- ── One record per remittance email (the audit log + raw archive) ───────────
create table if not exists public.remittance_emails (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         text references public.remittance_vendors(id),
  resend_email_id   text unique,                   -- ingest idempotency
  from_addr         text,
  subject           text,
  payment_reference text,                          -- goes into SF payment reference_number
  payment_date      text,
  payment_amount    numeric(12,2),
  received_at       timestamptz not null default now(),
  raw_text          text,                          -- retained copy
  raw_html          text,                          -- retained copy
  status            text not null default 'needs_review'
    check (status in ('parsing','needs_review','applied','partial','failed','error')),
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_remittance_emails_received on public.remittance_emails(received_at desc);

-- ── One row per remittance line (parsed → matched → applied) ────────────────
create table if not exists public.remittance_payments (
  id                uuid primary key default gen_random_uuid(),
  email_id          uuid not null references public.remittance_emails(id) on delete cascade,
  line_no           int not null,
  -- Parsed
  po                text,
  customer_name     text,                          -- Clopay only (for name validation)
  vendor_ref        text,                          -- Clopay invoice # / OHD document reference #
  amount            numeric(12,2) not null,
  doc_date          text,
  -- Matched
  match_status      text not null default 'pending'
    check (match_status in ('matched','ambiguous','no_match','amount_mismatch')),
  sf_job_id         text,
  sf_job_number     text,
  matched_customer  text,
  open_amount       numeric(12,2),
  match_confidence  numeric(4,3),
  candidates        jsonb,                         -- when ambiguous, the options
  -- Applied
  apply_status      text not null default 'pending'
    check (apply_status in ('pending','approved','applied','excluded','failed')),
  applied_amount    numeric(12,2),
  sf_payment_response jsonb,
  applied_at        timestamptz,
  applied_by        uuid references public.profiles(id),
  error             text,
  -- Idempotency: the same payment line can't be applied twice across re-sends/re-runs.
  dedup_key         text not null unique,
  created_at        timestamptz not null default now()
);
create index if not exists idx_remittance_payments_email on public.remittance_payments(email_id);
create index if not exists idx_remittance_payments_job   on public.remittance_payments(sf_job_id);

-- ── RLS: admin-only (financial data) ────────────────────────────────────────
alter table public.remittance_vendors  enable row level security;
alter table public.remittance_emails    enable row level security;
alter table public.remittance_payments  enable row level security;
drop policy if exists "admin_all_remittance_vendors" on public.remittance_vendors;
create policy "admin_all_remittance_vendors" on public.remittance_vendors for all using (public.is_admin());
drop policy if exists "admin_all_remittance_emails" on public.remittance_emails;
create policy "admin_all_remittance_emails" on public.remittance_emails for all using (public.is_admin());
drop policy if exists "admin_all_remittance_payments" on public.remittance_payments;
create policy "admin_all_remittance_payments" on public.remittance_payments for all using (public.is_admin());
