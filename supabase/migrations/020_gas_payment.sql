-- Gas payment eligibility per tech, and per-job gas tracking
alter table public.profiles
  add column if not exists gas_eligible boolean not null default false;

alter table public.jobs
  add column if not exists gas_paid boolean not null default false;
