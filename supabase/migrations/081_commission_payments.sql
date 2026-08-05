-- Commission payments — append-only disbursement ledger.
--
-- Records what an admin actually PAID a technician for a (tech, period),
-- supporting PARTIAL payments (multiple rows summed). This has NO effect on the
-- commission math — commission_received (lib/commission/calc.ts) remains the
-- source of truth for what's OWED. Balance owed = commission_received − Σ paid.
--
-- Positive amounts only (a mistake is corrected by deleting the row, not a
-- negative entry). paid_on is a bare date and is NOT constrained to the period
-- (a month can be paid later). RLS mirrors commission_adjustments: admin-all,
-- techs read only their own.
create table if not exists public.commission_payments (
  id            uuid primary key default gen_random_uuid(),
  tech_user_id  uuid not null references public.profiles(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  amount        numeric(12,2) not null check (amount > 0),
  paid_on       date not null,
  method        text,   -- optional free text: check / ach / cash …
  note          text,   -- optional
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_comm_pay_tech   on public.commission_payments(tech_user_id);
create index if not exists idx_comm_pay_period on public.commission_payments(period_start, period_end);

alter table public.commission_payments enable row level security;
drop policy if exists "admin_all_commission_payments" on public.commission_payments;
create policy "admin_all_commission_payments" on public.commission_payments
  for all using (public.is_admin());
drop policy if exists "tech_own_commission_payments" on public.commission_payments;
create policy "tech_own_commission_payments" on public.commission_payments
  for select using (tech_user_id = auth.uid());
