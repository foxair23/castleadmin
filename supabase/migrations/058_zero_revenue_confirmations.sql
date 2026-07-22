-- True-$0 confirmations: a completed job legitimately carries $0 (no revenue is
-- coming — e.g. a warranty/no-charge visit), as opposed to a $0 job that's just
-- awaiting a 3rd-party partner total. Flagging a job here removes it from the
-- Action Items "Awaiting Revenue" tab and moves it to the Dashboard's
-- "Confirmed $0" count. Presence of a row = confirmed true-$0.

create table if not exists public.zero_revenue_confirmations (
  sf_job_id     text primary key references public.sf_jobs(id) on delete cascade,
  confirmed_by  uuid references public.profiles(id) on delete set null,
  confirmed_at  timestamptz not null default now()
);

alter table public.zero_revenue_confirmations enable row level security;

-- Admins manage; writes go through the role-checked API using the service role.
drop policy if exists "admin_all_zero_revenue_confirmations" on public.zero_revenue_confirmations;
create policy "admin_all_zero_revenue_confirmations" on public.zero_revenue_confirmations
  for all using (public.is_admin());
