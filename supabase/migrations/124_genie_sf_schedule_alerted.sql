-- Genie schedule sync: remember when the office was told a job needs its schedule set by hand.
--
-- The extension reports the appointments it could not write at the end of each run, and the
-- app emails one list of jobs to fix manually. Without this stamp a job that keeps failing
-- would be in that email on every poll; with it, a job is flagged once, and again only if it
-- is still failing a day later.
alter table public.vendor_orders
  add column if not exists sf_schedule_alerted_at timestamptz;
