-- "Why didn't the form go out?" could only be answered by reading the sweep's code and
-- guessing which gate stopped it — the reasons lived in the cron's JSON response and were
-- gone as soon as it returned. Each evaluation now leaves its answer on the document.
alter table public.esign_documents
  add column if not exists last_hold_reason text,
  add column if not exists last_evaluated_at timestamptz;

comment on column public.esign_documents.last_hold_reason is
  'Why the last sweep did not send anything for this document (or what it sent). Diagnostic only — never a gate.';
