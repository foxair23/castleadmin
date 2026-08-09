-- Two-strikes grace period for the weekly SF reconcile.
--
-- The reconcile marks any mirror row NOT returned by a full SF scan as
-- is_deleted. But SF's paginated API occasionally drops a page (or returns an
-- empty body without erroring), which false-flags active records as deleted —
-- e.g. an active job hidden from PO/job matching. sf_missing_since records the
-- first time a row went missing; the reconcile only soft-deletes once a row has
-- been missing past the grace window (≈ two weekly runs), and clears the stamp
-- the moment the row reappears. A single flaky scan can no longer delete.

alter table public.sf_jobs           add column if not exists sf_missing_since timestamptz;
alter table public.sf_estimates      add column if not exists sf_missing_since timestamptz;
alter table public.sf_invoices       add column if not exists sf_missing_since timestamptz;
alter table public.sf_calendar_tasks add column if not exists sf_missing_since timestamptz;
