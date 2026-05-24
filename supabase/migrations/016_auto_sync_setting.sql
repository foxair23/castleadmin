-- Add auto_sync_to_sf setting (default off)
INSERT INTO public.scheduler_settings (key, value)
VALUES ('auto_sync_to_sf', 'false')
ON CONFLICT (key) DO NOTHING;
