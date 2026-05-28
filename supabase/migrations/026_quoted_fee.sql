-- Store the fee quoted to the customer at booking time
alter table public.scheduler_leads
  add column if not exists quoted_fee text;
