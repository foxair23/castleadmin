-- "The customer signed the paper copy in front of the technician."
--
-- Stopping the e-sign series for one of these used to mean pressing Cancel, which says the
-- form is no longer needed. It is: Home Depot still wants the signed sheet uploaded to
-- Clopay, and a cancelled form raises no "Upload SOF to Clopay" item, so the paper copy had
-- nothing chasing it and could simply be forgotten.
--
-- So a distinct end state. It stops every customer and technician message immediately, like
-- a cancellation, but it stays on the Clopay list so the signed sheet still reaches the
-- portal. `cancelled` keeps its old meaning: this form is not wanted at all.
alter table public.esign_documents
  drop constraint if exists esign_documents_status_check;

alter table public.esign_documents
  add constraint esign_documents_status_check check (status in (
    'found','unrecognised_template','prepared','sent_customer','customer_signed',
    'sent_tech','tech_signed','completed','sf_uploaded','portal_uploaded',
    'signed_offline','cancelled'));

-- Who marked it and when, so the Signatures page can say so rather than just going quiet.
alter table public.esign_documents
  add column if not exists signed_offline_at timestamptz,
  add column if not exists signed_offline_by text;
