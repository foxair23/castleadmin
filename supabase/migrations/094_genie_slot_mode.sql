-- Genie scheduler booking granularity. Two modes:
--   'windows' — the customer picks a date AND an arrival time window (default).
--   'day'     — the customer only picks a date; no time window (tech calls ahead).
-- Change the value to switch what customers are offered.
insert into public.scheduler_settings (key, value)
select 'genie_slot_mode', '"windows"'::jsonb
where not exists (select 1 from public.scheduler_settings where key = 'genie_slot_mode');
