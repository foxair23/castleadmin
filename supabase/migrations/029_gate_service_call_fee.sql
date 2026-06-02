-- Add configurable gate service call fee setting (defaults to same as garage door fee)
insert into public.scheduler_settings (key, value)
values ('gate_service_call_fee', '99'::jsonb)
on conflict (key) do nothing;
