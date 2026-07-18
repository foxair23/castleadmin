-- ============================================================
-- Migration 057: work date — start_date-first for invoice-stamped rows
-- ============================================================
-- The pure start-date basis (Service Fusion's own Sales Revenue basis) showed
-- June 2026 ($96.4K) BEAT May ($83.9K) — the opposite of the work-date chart —
-- because the prompt-invoice tier counted jobs at their invoice date, sliding
-- month-end work into the next month (e.g. worked Jun 25, invoiced Jul 3 →
-- counted July). The July invoicing catch-up amplified this: ~$27K of real
-- June work sat in July's bucket.
--
-- For this business (mostly single-visit jobs) the work happens ON start_date;
-- the invoice follows days later. New historical priority:
--   1. real observed "Completed" transition  (kept — exact evidence)
--   2. start_date                            (this migration: replaces the
--                                             prompt-invoice stamp too)
--   3. closed_at                             (only rows with no sane start —
--                                             mostly 2025, where lag was small)
-- Trade-off (owner-approved): a genuinely multi-week job counts at its start.
-- Going forward, the sync's live observed-completion stamping remains the
-- gold standard; jobs arriving straight at Invoiced now also prefer start_date
-- (see stampWorkCompleted).
-- ============================================================

update public.sf_jobs
set    work_completed_at = start_date::timestamptz
where  work_completed_at is not null
  and  work_completed_at = closed_at
  and  start_date is not null
  and  start_date > date '2000-01-01';
