-- Genie self-scheduling: let a Home Depot / Genie customer pick their install
-- appointment from a public widget, which writes the chosen date + time window
-- back onto the SF job we already created for their order (create-sf-job.ts).
--
-- The customer identifies themselves by the phone or email on their Genie order;
-- we match it to a vendor_orders row that already has an sf_job_id, confirm it,
-- collect the pre-install qualification answers, and update that job. Nothing new
-- is created in SF — this only schedules the existing job.

-- Customer-chosen appointment (distinct from `schedule_date`, which is the
-- portal's own schedule-by date scraped from Home Depot).
alter table public.vendor_orders
  add column if not exists appointment_date         date,
  add column if not exists appointment_window_start text,   -- 'HH:MM' (LA wall clock)
  add column if not exists appointment_window_end   text,   -- 'HH:MM'
  add column if not exists scheduled_at             timestamptz,   -- when the customer booked
  add column if not exists scheduled_contact_phone  text,
  add column if not exists scheduled_contact_email  text,
  add column if not exists schedule_answers         jsonb;   -- the pre-install qualification answers

create index if not exists idx_vendor_orders_appointment on public.vendor_orders (appointment_date);

-- A dedicated widget instance so the Genie scheduler reuses the existing
-- widget-key gating + availability endpoint. Its lead_source/sf_job_source tag
-- it in the widgets list; the Genie flow updates existing jobs rather than
-- creating leads, so those values are only for identification. Grab the embed
-- link (api_key) from Admin → Scheduler → Widgets.
insert into public.scheduler_widget_instances (display_name, lead_source, sf_job_source, api_key, is_active)
select 'Genie / Home Depot install scheduling', 'genie', 'Genie', 'genie_' || replace(gen_random_uuid()::text, '-', ''), true
where not exists (
  select 1 from public.scheduler_widget_instances where lead_source = 'genie'
);
