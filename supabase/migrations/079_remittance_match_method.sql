-- Record HOW each remittance line matched a job, so review and (later) autopilot
-- can trust PO matches and require a human on name-only matches.
--   'po'      — matched by PO number
--   'po_name' — matched by PO, customer name validated (Clopay)
--   'name'    — PO missing/wrong in SF; matched by customer name (needs a human)
alter table public.remittance_payments
  add column if not exists match_method text;
