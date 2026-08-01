-- Customer pre-work approvals — a dispute-proof record that the customer approved
-- the itemized price BEFORE work was done. Modeled on commission_plan_acceptances
-- (045): append-only, with an immutable snapshot + fingerprint + IP/user-agent.
--
-- Entry point is a tokenized no-login link (texted or emailed to the customer),
-- so unlike the commission flow there is no authenticated tech behind it — the
-- unguessable token is the authorization to view + approve that one quote.
--
-- Deliberately generic so later work bolts on without a migration:
--   • source_type/source_id — 'job' today; 'estimate'/'invoice' later.
--   • status enum already carries declined/expired for a future decline/expiry UI.
--   • verification_method — null today; reserved for an OTP/identity step later.
--   • line_items_snapshot jsonb — the full itemized quote, so richer per-line
--     logic can layer on without schema changes.

create table if not exists public.job_approvals (
  id                  uuid primary key default gen_random_uuid(),
  -- What is being approved. Generic so estimates/invoices can reuse this table.
  source_type         text not null default 'job',
  source_id           text not null,            -- e.g. sf_jobs.id
  -- Unguessable entry token for the public /approve/<token> link.
  token               text not null unique,
  -- Customer contact captured at send time (resolved from the SF mirror, but the
  -- operator can override before sending, so this is the address we actually used).
  customer_name       text,
  customer_email      text,
  customer_phone      text,
  -- Immutable snapshot of exactly what was presented for approval.
  line_items_snapshot jsonb not null,           -- [{ name, description, quantity, unit_price, total }]
  amount_total        numeric(12,2),
  legal_version       text not null,
  terms_fingerprint   text not null,            -- hash(snapshot + legal_version)
  -- pending → approved (or declined/expired). Stamped once on approval.
  status              text not null default 'pending'
                        check (status in ('pending','approved','declined','expired')),
  verification_method text,                      -- reserved (e.g. 'otp'); null = none
  sent_channels       text[],                    -- ['email'], ['sms'], or both
  sent_at             timestamptz,
  approved_at         timestamptz,
  approved_name       text,                      -- typed full-name signature
  ip                  text,
  user_agent          text,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_job_approvals_source  on public.job_approvals(source_type, source_id);
create index if not exists idx_job_approvals_status  on public.job_approvals(status);
create index if not exists idx_job_approvals_created on public.job_approvals(created_at desc);

alter table public.job_approvals enable row level security;

-- Admin + sales operate the send flow and read the log. The public approval page
-- and accept API use the service role (token-authed), bypassing RLS.
drop policy if exists "admin_all_job_approvals" on public.job_approvals;
create policy "admin_all_job_approvals" on public.job_approvals
  for all using (public.is_admin());

drop policy if exists "sales_read_job_approvals" on public.job_approvals;
create policy "sales_read_job_approvals" on public.job_approvals
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin','sales') and p.is_active
    )
  );

grant select, insert, update on public.job_approvals to service_role;
grant select on public.job_approvals to authenticated;

-- Keep updated_at fresh on stamps.
drop trigger if exists trg_job_approvals_updated_at on public.job_approvals;
create trigger trg_job_approvals_updated_at
  before update on public.job_approvals
  for each row execute function public.set_updated_at();
