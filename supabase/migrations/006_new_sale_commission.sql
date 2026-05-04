alter table public.job_types
  add column if not exists requires_sale_amount boolean not null default false;

insert into public.job_types (name, base_rate, additional_rate, requires_quantity, requires_sale_amount, is_active)
values ('New Sale Commission', 0, null, false, true, true);
