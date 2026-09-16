-- Unmatching a job Castle Admin CREATED is now allowed (the office sometimes needs to undo
-- a wrong create). Clearing sf_created_job_number would make the order eligible for
-- autopilot again, which would create a SECOND job in SF while the first one is still
-- sitting there. This stamp says "a human took this order off autopilot" — creation goes
-- back to being the + Create SF Job button.
alter table public.vendor_orders
  add column if not exists sf_autopilot_blocked_at timestamptz;

comment on column public.vendor_orders.sf_autopilot_blocked_at is
  'Set when an admin unmatches an SF job from this order. Autopilot skips these rows forever; a job is created by hand from here on.';
