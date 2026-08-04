-- Completion Resets log.
--
-- A job's work_completed_at is the app's source of truth for "when the work was
-- done" — it drives commission recognition AND the Monthly Revenue chart, and is
-- deliberately never overwritten (so noisy re-syncs can't move a job's month).
--
-- But a job can be marked Completed in Service Fusion prematurely (e.g. when a
-- part is paid for) and then corrected back to an open status like "Waiting on
-- Parts". Because work_completed_at is never un-set, the job would stay
-- recognized as complete forever. The sync now DETECTS that reversion (a stamped
-- job whose current status is no longer completed-ish), clears work_completed_at
-- so it re-recognizes on its real completion date later, and records the reset
-- here — surfaced on the Commission → Completion Resets tab so no pay/revenue
-- ever moves silently. `had_payment` flags the ones worth eyeballing (a paid
-- invoice was already attached).

create table if not exists public.commission_completion_resets (
  id                     uuid primary key default gen_random_uuid(),
  sf_job_id              text not null,
  job_number             text,
  customer_name          text,
  old_work_completed_at  timestamptz,        -- the discarded (premature) completion date
  current_status         text,               -- the reverted status, e.g. 'waiting on parts'
  job_total              numeric(12,2),       -- revenue snapshot at reset time
  had_payment            boolean not null default false,  -- paid invoice or closed_at present → eyeball
  tech_user_id           uuid references public.profiles(id) on delete set null,
  tech_name              text,               -- snapshot for display
  reset_at               timestamptz not null default now()
);
create index if not exists idx_comm_resets_reset_at on public.commission_completion_resets(reset_at desc);
create index if not exists idx_comm_resets_job      on public.commission_completion_resets(sf_job_id);

alter table public.commission_completion_resets enable row level security;
drop policy if exists "admin_all_commission_completion_resets" on public.commission_completion_resets;
create policy "admin_all_commission_completion_resets" on public.commission_completion_resets for all using (public.is_admin());
