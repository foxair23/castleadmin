-- E-signed vendor documents (phase 1: the Clopay lien waiver, "Blank ICA/LW").
--
-- Home Depot requires a signed completion form for every Clopay install. The Clopay crawl
-- already stores every portal document per order; this is the record of one document's
-- journey from "found in the portal" to "signed by customer and tech, filed on the SF job,
-- uploaded back to the portal". One row per HOUSE (root order — a multi-door group is one
-- job) and document type. Tokens are the customer's and the technician's signing links.
--
-- Vendor and doc_type are first-class so the SF&I form and Genie's form (phase 2) reuse
-- every table and screen. Nothing here sends anything: esign_settings is OFF by default and
-- carries an enabled_at cutoff, so the blanks already on file are never auto-sent.

create table if not exists public.esign_documents (
  id                      uuid primary key default gen_random_uuid(),
  vendor                  text not null,                  -- 'clopay_hd'
  doc_type                text not null,                  -- 'lien_waiver' (phase 2: 'sfi_form', 'genie_completion')
  template_key            text,                           -- null until the blank matched a registered layout
  template_fingerprint    text,                           -- set once inspected, even when unrecognised
  order_id                uuid not null references public.vendor_orders(id) on delete cascade,   -- the ROOT order
  source_attachment_id    uuid references public.vendor_order_attachments(id) on delete set null,
  sf_job_id               text,
  status                  text not null default 'found' check (status in (
                            'found','unrecognised_template','prepared','sent_customer','customer_signed',
                            'sent_tech','tech_signed','completed','sf_uploaded','portal_uploaded','cancelled')),
  customer_token          text not null unique,
  tech_token              text not null unique,
  prefill                 jsonb not null default '{}'::jsonb,
  prepared_pdf_path       text,
  customer_sent_at        timestamptz,
  customer_sent_channels  text,
  customer_asked_at       timestamptz,                    -- the "please sign" message (day after install)
  customer_reminded_at    timestamptz,
  customer_signed_at      timestamptz,
  customer_signed_name    text,
  customer_ip             text,
  customer_user_agent     text,
  customer_sig_path       text,
  customer_fields         jsonb,
  tech_id                 text,
  tech_name               text,
  tech_sent_at            timestamptz,
  tech_sent_channels      text,
  tech_reminded_at        timestamptz,
  tech_signed_at          timestamptz,
  tech_signed_name        text,
  tech_ip                 text,
  tech_user_agent         text,
  tech_sig_path           text,
  no_tech_alerted_at      timestamptz,
  completed_pdf_path      text,
  completed_at            timestamptz,
  sf_uploaded_at          timestamptz,
  sf_upload_alerted_at    timestamptz,
  portal_uploaded_at      timestamptz,
  portal_uploaded_by      text,                           -- a person's name, or 'portal:signed_doc'
  signed_attachment_id    uuid references public.vendor_order_attachments(id) on delete set null,
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (order_id, doc_type)
);
create index if not exists idx_esign_documents_status on public.esign_documents (status);
create index if not exists idx_esign_documents_order  on public.esign_documents (order_id);

alter table public.esign_documents enable row level security;
drop policy if exists admin_all_esign_documents on public.esign_documents;
create policy admin_all_esign_documents on public.esign_documents
  for all using (public.is_admin()) with check (public.is_admin());

-- Per vendor + document type. OFF by default; enabled_at is the cutoff (mirrors vendor_schedule_nudge).
create table if not exists public.esign_settings (
  vendor      text not null,
  doc_type    text not null,
  enabled     boolean not null default false,
  enabled_at  timestamptz,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (vendor, doc_type)
);
alter table public.esign_settings enable row level security;
drop policy if exists admin_all_esign_settings on public.esign_settings;
create policy admin_all_esign_settings on public.esign_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- What the crawl knows about a document that the stored filename does not: Clopay's own
-- document type, and the portal name BEFORE it was made filesystem-safe (URL-style names
-- like ".../document/LW/181193546-46664198" are mangled by safeName and unrecognisable after).
alter table public.vendor_order_attachments
  add column if not exists doc_type       text,
  add column if not exists raw_name       text,
  add column if not exists esign_doc_type text;     -- classifier verdict: 'lien_waiver' | 'lien_waiver_signed' | 'none'; null = not yet classified
create index if not exists idx_vendor_order_attachments_esign_unclassified
  on public.vendor_order_attachments (created_at)
  where esign_doc_type is null;
