-- A capture that carried no document.
--
-- The Clopay portal (Oracle) answers some document requests with a fixed-size file of zero
-- bytes rather than the document — known, expected behaviour on their side, not a bug in the
-- capture. We keep those files, but we should not treat them as "this document is done":
-- marking them lets the crawler try that document again on a later run, in case the portal
-- serves the real thing, and the capture overwrites the placeholder in place.
alter table public.vendor_order_attachments
  add column if not exists capture_unusable boolean not null default false;

-- The known batch: 1,280,000 bytes is the size the portal serves in this case. Marking them
-- is what puts them back in the crawler's path — nothing is deleted.
update public.vendor_order_attachments
   set capture_unusable = true
 where byte_size = 1280000
   and capture_unusable = false;

-- The crawler's dedup check reads this per (order, document), so keep it cheap.
create index if not exists idx_vendor_order_attachments_unusable
  on public.vendor_order_attachments (order_id, external_ref)
  where capture_unusable;
