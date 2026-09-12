-- "Unmatch" on HD Orders. The SF Job # column is mostly a COMPUTED match (PO, then customer
-- name, email, phone) — clearing sf_job_id alone would not help, the matcher would find the
-- same wrong job again on the next page load. So an unmatch also records the rejected job
-- on every row of the house; the matcher skips those ids for this order from then on.
alter table public.vendor_orders
  add column if not exists sf_match_excluded_job_ids text[] not null default '{}';
