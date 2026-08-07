-- Customer-facing-action → Service Fusion job note (audit trail).
--
-- Whenever Castle Admin does something the customer sees (today: an invoice
-- reminder email/SMS), we want a matching note on the SF job so the office has
-- one source of truth in SF. Service Fusion has no public API to add a note to
-- an existing job, so — exactly like the remittance payment flow — the app is
-- the source of truth (it queues the note) and a browser extension is the arm
-- that posts it by driving SF's web form (POST /jobs/addNewNoteAjax) in the
-- user's logged-in session.
--
-- State machine (status): pending → posted | failed. The extension reads
-- `pending` rows, posts each to SF, and calls back with the result.
--
-- Extensible by `event`: 'invoice_reminder' is the first source; CSAT,
-- lead-gen outreach, etc. can enqueue with the same shape later.

create table if not exists public.sf_note_queue (
  id               uuid primary key default gen_random_uuid(),
  -- Numeric SF job id (matches sf_jobs.id) — posted verbatim as addNewNoteAjax's
  -- `id` field. NOT the hashed web id from the job URL.
  sf_job_id        text not null,
  note_text        text not null,
  event            text not null,                     -- 'invoice_reminder' | (future: 'csat' | 'leadgen' | …)
  -- Idempotent enqueue: the caller builds a stable key (e.g.
  -- 'invoice_reminder:<invoiceId>:<stageIndex>') so retries / double-fires never
  -- double-post a note. Nullable for callers that don't need dedup.
  dedup_key        text unique,
  status           text not null default 'pending',   -- 'pending' | 'posted' | 'failed'
  attempts         integer not null default 0,
  -- Where the note came from, for the admin UI / debugging.
  ref_table        text,                              -- e.g. 'invoice_reminders'
  ref_id           text,
  sf_note_response jsonb,
  error            text,
  created_at       timestamptz not null default now(),
  posted_at        timestamptz
);

-- The extension polls for work by status; keep that lookup cheap.
create index if not exists idx_sf_note_queue_status on public.sf_note_queue (status);
create index if not exists idx_sf_note_queue_job on public.sf_note_queue (sf_job_id);

alter table public.sf_note_queue enable row level security;
create policy "admin_all_sf_note_queue" on public.sf_note_queue for all using (public.is_admin());
