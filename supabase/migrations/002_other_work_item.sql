-- Add custom description field for "Other" work items
alter table public.job_work_items add column custom_description text;

-- Add the "Other" job type (pinned at bottom of dropdown)
insert into public.job_types (name, base_rate, additional_rate, requires_quantity, is_active)
values ('Other', 0, null, false, true);
