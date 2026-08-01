-- Add a line total to sf_job_items so mirrored job line items carry the
-- extended price (qty × unit_price, as SF reports it), not just the unit price.
-- Nullable: SF doesn't always return a total, and older rows won't have one.

alter table public.sf_job_items
  add column if not exists total numeric(12,2);
