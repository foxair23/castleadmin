-- AI residual-match suggestions. Runs only on lines deterministic matching left
-- as no_match / ambiguous. The suggestion is advisory — a human confirms it at
-- apply time; it NEVER overwrites the deterministic match_status/sf_job_id.
alter table public.remittance_payments
  add column if not exists ai_suggested_job_id     text,
  add column if not exists ai_suggested_job_number text,
  add column if not exists ai_suggested_customer   text,
  add column if not exists ai_confidence           numeric(4,3),
  add column if not exists ai_reason               text,
  add column if not exists ai_reviewed_at          timestamptz;
