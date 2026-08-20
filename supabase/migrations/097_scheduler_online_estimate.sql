-- Scheduler "Free Online Estimate" path (garage door only). Eligible customers
-- (new door / new-or-added opener) can opt to send photos + a short video instead
-- of booking a visit; we create a $0 Service Fusion estimate for the team to price
-- and email the customer their quote. This migration adds the lead marker + SF
-- estimate columns, widens the uploads bucket to accept video, and seeds the
-- feature toggle (default OFF — the one-click revert).

-- Lead marker + captured SF estimate identity.
alter table public.scheduler_leads
  add column if not exists estimate_channel            text,   -- null | 'online'
  add column if not exists service_fusion_estimate_id     text,
  add column if not exists service_fusion_estimate_number  text;

-- Widen the uploads bucket: allow video (iPhone records .mov = video/quicktime)
-- and raise the hard ceiling to 100 MB so a short clip fits. Per-file caps by
-- type are still enforced in the sign route.
update storage.buckets
set file_size_limit = 104857600,  -- 100 MB
    allowed_mime_types = array[
      'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
      'video/mp4','video/quicktime','video/webm'
    ]
where id = 'scheduler-uploads';

-- Settings: the feature toggle (default OFF) + a video size cap (MB).
insert into public.scheduler_settings (key, value) values
  ('online_estimate_enabled',      'false'),
  ('online_estimate_max_video_mb', '100')
on conflict (key) do nothing;

-- Notification type: team alert when a customer submits an online estimate request.
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values
  ('scheduler_online_estimate',
   'Online Estimate Request',
   'Alert when a customer submits a Free Online Estimate (photos to price)',
   'scheduler',
   array['admin','sales']::text[],
   false)
on conflict (key) do nothing;
