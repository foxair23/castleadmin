-- Add configurable service call fee setting (default $99)
insert into public.scheduler_settings (key, value)
values ('service_call_fee', '99'::jsonb)
on conflict (key) do nothing;
