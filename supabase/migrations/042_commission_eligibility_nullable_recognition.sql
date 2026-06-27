-- Allow denying commission on a job at ANY stage (TRD §3.4, extended).
--
-- Denying a not-yet-completed (Sold/Scheduled) job creates a
-- commission_job_eligibility row with status='not_accepted' before the job has
-- a completion date, so recognition_date must be nullable. When the job later
-- completes, the sync sets recognition_date to its closed_at while preserving
-- the admin's denial.

alter table public.commission_job_eligibility
  alter column recognition_date drop not null;
