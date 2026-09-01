-- Clopay IPO — re-queue the parses so recovered rows pick up corrected details.
--
-- A recovered order's customer fields were written on INSERT only, so improvements to the
-- parser never reached rows already recovered: the SHIP TO name fix shipped and re-parsed,
-- and "PIERIK, MAGGIE 56505 HOME DEPOT INC#658" survived it unchanged. The parser now
-- refreshes those fields on every parse (for record_source='ipo_document' rows only — the
-- crawler's own data is always better for portal rows).
--
-- Clearing parsed_at re-queues the documents; line items are replaced per document rather
-- than duplicated, and the stored PDFs are untouched.
update public.vendor_order_attachments
   set parsed_at = null
 where source = 'clopay_doc'
   and parse_status in ('ok', 'mismatch', 'sibling_doc');
