-- Capacity and lead-time settings for the scheduler
insert into public.scheduler_settings (key, value) values
  ('min_notice_hours',        '24'),
  ('max_jobs_per_day',        '0'),
  ('max_bookings_per_window', '0')
on conflict (key) do nothing;
