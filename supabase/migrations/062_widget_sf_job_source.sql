-- Per-widget Service Fusion Job Source (marketing attribution).
--
-- Every scheduler widget creates its SF job with a hardcoded source of
-- 'Website'. To attribute bookings from different widgets to different sources
-- in Service Fusion, make the SF Job Source configurable per widget.
--
-- The value is snapshotted onto the lead at booking time (like lead_source),
-- so the SF sync sends the source the widget was set to when the booking
-- happened, even if the widget's config later changes.
alter table public.scheduler_widget_instances
  add column if not exists sf_job_source text not null default 'Website';

alter table public.scheduler_leads
  add column if not exists sf_job_source text;

comment on column public.scheduler_widget_instances.sf_job_source is
  'The Service Fusion Job Source this widget stamps on the jobs it creates (must match an SF source short_name). Defaults to Website.';
