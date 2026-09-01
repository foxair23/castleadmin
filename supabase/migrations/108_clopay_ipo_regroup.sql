-- Clopay IPO — re-link groups after the grouping rule and two parse fixes.
--
-- 0. The portal line owns everything hanging off it. A document sits under ONE order in the
--    HD portal, and every order it names belongs to that line's job — including when Clopay
--    serves an order only its siblings' IPOs (its document list is keyed by incident/PO).
--    Groups now MERGE rather than being rebuilt from a single document, so a customer whose
--    doors arrive across several documents lands in one group instead of the last document
--    winning. One portal line = one job = one SF job.
--
-- 1. Group primaries were chosen wrong. linkOrderGroup treated "a row for this order already
--    existed" as "this order came from the portal", so a door recovered by an earlier document
--    counted as a portal order and the group's primary collapsed to the lowest order number.
--    Real portal orders — the only rows carrying status, notes, schedule and documents — ended
--    up as children of status-less recovered rows (FARRELL ISABELLE: portal order 181194282,
--    "Install/Delivery Completed", hanging off recovered 181193445).
-- 2. A customer's SHIP TO name absorbed the installer and sold-to columns when the order had
--    no phone on file ("PIERIK, MAGGIE 56505 HOME DEPOT INC#658").
--
-- Both are corrected in the parser, so clear the derived grouping and re-parse. Line items are
-- replaced per document on re-parse, so this cannot duplicate anything; the stored PDFs are
-- untouched and remain the source of truth.
--
-- Note on 'sibling_doc': a document that names none of its own order's line items is not a
-- failure — every section is still filed against the order it names, and the whole set is
-- grouped under the portal line the document sits on. The re-parse relabels these from
-- 'mismatch' (which read as a parse failure) to 'sibling_doc'.

comment on column public.vendor_order_attachments.parse_status is
  'IPO parse outcome: ok (line fees sum to the stated TOTAL), mismatch (they do not — check the PDF), sibling_doc (parsed fine, but carries no section for the order it hangs off — Clopay served a sibling order''s IPO), error, not_ipo';

-- Drop the derived grouping; the re-parse rebuilds it from the documents.
update public.vendor_orders
   set parent_order_id = null
 where vendor = 'clopay_hd'
   and parent_order_id is not null;

-- Re-queue every document that produced a parse (not the 675 non-IPOs).
update public.vendor_order_attachments
   set parsed_at = null
 where source = 'clopay_doc'
   and parse_status in ('ok', 'mismatch', 'sibling_doc');
