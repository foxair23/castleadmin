-- E-sign, second half: filing the completed form and telling the office.
--
-- sf_document_upload_queue: the completed PDF goes onto the Service Fusion job through the
-- Chrome extension (SF has no document API), exactly like notes (083), IPO line items and
-- Genie appointments. The app queues WHAT to upload; the extension uploads it through SF's
-- logged-in web session and calls back. `discovery` holds what the extension learned about
-- SF's upload form before the real request was captured.
--
-- esign_office_alert: one notification type for the office-facing e-sign alerts — no
-- technician on a job whose customer has signed; a completed form the extension could not
-- file. Admins are subscribed by default.

create table if not exists public.sf_document_upload_queue (
  id              uuid primary key default gen_random_uuid(),
  sf_job_id       text not null,                      -- numeric SF job id (sf_jobs.id)
  sf_job_number   text,                               -- for global search → hashed web id
  storage_path    text not null,                      -- in the vendor-order-attachments bucket
  filename        text not null,
  dedup_key       text unique,
  status          text not null default 'pending',    -- pending | posted | failed
  attempts        integer not null default 0,
  ref_table       text,
  ref_id          text,
  discovery       jsonb,                              -- what the extension found on the SF page
  discovered_at   timestamptz,
  sf_response     jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  posted_at       timestamptz
);
create index if not exists idx_sf_doc_upload_status on public.sf_document_upload_queue (status);
alter table public.sf_document_upload_queue enable row level security;
drop policy if exists admin_all_sf_document_upload_queue on public.sf_document_upload_queue;
create policy admin_all_sf_document_upload_queue on public.sf_document_upload_queue
  for all using (public.is_admin()) with check (public.is_admin());

insert into public.notification_types (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'esign_office_alert',
  'E-sign needs attention',
  'A signed Home Depot form needs the office: no technician assigned to sign, or the completed form could not be filed on the SF job.',
  'operations',
  array['admin'],
  false
)
on conflict (key) do nothing;

-- Existing admins get the new type on (mirrors how other seeded types reach current users).
insert into public.user_notification_preferences (user_id, notification_type_id, is_enabled)
select p.id, t.id, true
from public.profiles p
join public.notification_types t on t.key = 'esign_office_alert'
where p.role = 'admin' and p.is_active
on conflict do nothing;
