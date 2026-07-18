-- ============================================================
-- Migration 056: work_completed_at — initial-snapshot artifact
-- ============================================================
-- The legacy status log came online May 10–12 2026, writing a first-snapshot
-- row per job (previous_status NULL — "here's the status it already had", not
-- a transition). The 054 backfill took the earliest completed-ish observation
-- as the work date, so jobs that were ALREADY Completed/Invoiced when logging
-- began — with their invoice stamp still in the future — got stamped at the
-- snapshot moment. Result: a phantom 132-job / ~$29K revenue spike on
-- 2026-05-11 (plus tail on the 12th) for work actually done earlier.
--
-- Fix: any row whose work date EQUALS an initial-snapshot observation is
-- re-derived from start_date (the 055 rule for date-evidence-less jobs), or
-- nulled when there is no sane start_date — an honest exclusion beats a
-- fabricated date. Scoped to the legacy log window (ended Jul 2) so rows
-- stamped by the new forward logging are untouched; rows stamped from REAL
-- observed transitions (previous_status NOT NULL) are untouched too.
-- ============================================================

update public.sf_jobs j
set work_completed_at = case
  when j.start_date is not null and j.start_date > date '2000-01-01'
    then j.start_date::timestamptz
  else null
end
where j.work_completed_at is not null
  and j.work_completed_at < timestamptz '2026-07-03 00:00:00+00'
  and exists (
    select 1
    from public.sf_job_status_history h
    where h.sf_job_id = j.id
      and h.observed_at = j.work_completed_at
      and h.previous_status is null
  );
