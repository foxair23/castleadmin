-- Genie installs can't be scheduled too soon — the customer's motor has to ship
-- first. This setting is the minimum lead time (in days from today) before the
-- earliest bookable Genie slot. Default 7 (one week out). Adjust the value to
-- change how far ahead the first offered date is.
--
-- Lives in scheduler_settings (the same key-value config table the scheduler
-- reads); the Genie scheduler reads it, and the book endpoint enforces it.
insert into public.scheduler_settings (key, value)
select 'genie_min_lead_days', '7'::jsonb
where not exists (select 1 from public.scheduler_settings where key = 'genie_min_lead_days');
