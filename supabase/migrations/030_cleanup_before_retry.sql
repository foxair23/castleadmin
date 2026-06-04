-- Run this BEFORE 030_email_notifications.sql to clean up any partial state
-- Safe to run even if nothing was created yet

DROP TABLE IF EXISTS public.notification_log CASCADE;
DROP TABLE IF EXISTS public.user_notification_preferences CASCADE;
DROP TABLE IF EXISTS public.notification_types CASCADE;
DROP FUNCTION IF EXISTS public.auto_populate_notification_preferences() CASCADE;
DROP FUNCTION IF EXISTS public.handle_is_dispatch_change() CASCADE;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_dispatch;
