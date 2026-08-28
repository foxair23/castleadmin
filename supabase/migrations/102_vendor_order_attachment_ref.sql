-- Store Clopay HD-Program document FILES on our own storage (not just links to
-- clopay.com). The crawler downloads each order's documents and uploads them to the
-- existing private `vendor-order-attachments` bucket. Add a dedup key so a re-crawl
-- never re-downloads a document we already have — keyed by Clopay's document id.

alter table public.vendor_order_attachments
  add column if not exists external_ref text;   -- Clopay documentId (for clopay_doc), else null

-- One stored copy per (order, Clopay document). Partial so manual/DC-reply uploads
-- (external_ref null) are unconstrained.
create unique index if not exists uq_vendor_order_attachments_ref
  on public.vendor_order_attachments (order_id, external_ref)
  where external_ref is not null;
