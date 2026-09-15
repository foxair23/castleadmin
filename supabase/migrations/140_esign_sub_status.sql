-- The HD SOF sub-statuses on the SF job, which the office and this app now share as the
-- handshake for the Home Depot sign-off form:
--
--   HD SOF Needed    set by the OFFICE. The form should go to the customer the morning of
--                    the job's scheduled date. This is an explicit instruction and overrides
--                    whatever the job's own status might suggest.
--   HD SOF Sent      set by US, once the customer has been sent the form.
--   HD SOF Complete  set by US, once both parties have signed AND the finished document has
--                    been filed on the job in Service Fusion.
--
-- Service Fusion's API cannot write a sub-status, so the Chrome extension does it through the
-- web session (POST /jobs/updateJobSubStatus). These columns are that queue — the same shape
-- as vendor_orders.sf_lines_status: the app decides what to write, the extension clicks, the
-- callback stamps the result.
alter table public.esign_documents
  add column if not exists sf_sub_status_target    text,        -- the name we want SF to hold
  add column if not exists sf_sub_status_status    text,        -- queued | done | failed
  add column if not exists sf_sub_status_queued_at timestamptz,
  add column if not exists sf_sub_status_set_at    timestamptz, -- when SF confirmed it
  add column if not exists sf_sub_status_note      text;

-- The extension's queue read: the few that are waiting, oldest first.
create index if not exists idx_esign_documents_sub_status_queued
  on public.esign_documents (sf_sub_status_queued_at)
  where sf_sub_status_status = 'queued';
