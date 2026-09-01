-- Clopay IPO parse — clear the stamps left by the broken filename matcher.
--
-- The first nightly sweep classified EVERY stored Clopay document as 'not_ipo': the matcher
-- required '^', '/' or '-' before "IP_", while Clopay's real filenames run the document id
-- straight into it ("142432482IP_7151173_3753297.pdf"). Because the sweep only looks at rows
-- with parsed_at is null, that one run permanently excluded the whole backlog — fixing the
-- matcher alone would still parse nothing.
--
-- Only reset the rows that were classified away. Documents that actually produced line items
-- ('ok' / 'mismatch') or failed to download ('error') are left exactly as they are.
update public.vendor_order_attachments
   set parsed_at = null,
       parse_status = null
 where source = 'clopay_doc'
   and parse_status = 'not_ipo';
