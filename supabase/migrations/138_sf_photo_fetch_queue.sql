-- Reputation Engine: job photos through the office Chrome extension.
--
-- Service Fusion's public API lists a job's pictures by bare file name and has
-- no file endpoint (service-fusion-api-docs_.pdf, typ.Picture). The bytes have
-- to come through the extension's Service Fusion web session, the same route
-- payments, line items, appointments and signed forms already take. The app
-- queues jobs that need photos; the extension opens each job page, pulls the
-- pictures, and posts them back one at a time; the 6am post pass then finds
-- them in job_photos like any other photo.

create table if not exists public.sf_photo_fetch_queue (
  id             uuid primary key default gen_random_uuid(),
  sf_job_id      text not null unique,               -- sf_jobs.id
  sf_job_number  text,                               -- for the extension's global search
  known_files    text[] not null default '{}',       -- file names the API listed (file_location)
  status         text not null default 'pending'
    check (status in ('pending','done','failed','no_pictures')),
  attempts       integer not null default 0,
  received       integer not null default 0,         -- photos stored from this fetch
  discovery      jsonb,                              -- what the extension saw on the job page
  discovered_at  timestamptz,
  error          text,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists idx_sf_photo_fetch_queue_status on public.sf_photo_fetch_queue(status, created_at);

do $$ declare t text; begin
  foreach t in array array['sf_photo_fetch_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;
