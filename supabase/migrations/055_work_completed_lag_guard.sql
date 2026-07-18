-- ============================================================
-- Migration 055: work_completed_at — invoice-lag guard
-- ============================================================
-- Follow-up to 054. The status-history backfill barely moved anything: this
-- SF account's workflow largely SKIPS the "Completed" status (223 Completed
-- observations vs 14,225 Invoiced), so most backlog jobs had no completion
-- evidence and kept their invoice-time stamp. After 054, July 2026 still
-- carried ~$44.6K of May/June work.
--
-- Rule: when a job's recognized date is the invoice stamp (work_completed_at
-- = closed_at) and the invoice lagged the (last-known) scheduled start by
-- more than 14 days, the work date is start_date. A start_date can run a
-- couple of weeks early on long jobs; recognizing April work in July is a
-- far larger error. Rows already corrected from status-history evidence
-- (work_completed_at <> closed_at) are left untouched — that evidence is
-- better than start_date.
--
-- The same 14-day guard is applied in the sync's forward stamping (see
-- stampWorkCompleted in lib/sf-mirror/sync-engine.ts), so jobs that skip
-- "Completed" and arrive at Invoiced months late don't repeat the distortion.
-- ============================================================

update public.sf_jobs
set    work_completed_at = start_date::timestamptz
where  is_deleted = false
  and  start_date is not null
  and  start_date > date '2000-01-01'
  and  closed_at is not null
  and  work_completed_at = closed_at
  and  closed_at - start_date::timestamptz > interval '14 days';
