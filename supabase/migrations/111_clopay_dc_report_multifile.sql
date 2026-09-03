-- A Monday DC run can arrive as SEVERAL emails.
--
-- The 31-Aug run came as two PDFs — the Home Depot program orders and Castle's own — and the
-- original unique index on report_date meant the second email replaced the first's rows,
-- leaving half the run recorded. One email is one report row; the POs from every file of a
-- run accumulate in clopay_dc_po_state, which is what the Action Items worklist reads.
--
-- resend_email_id keeps its unique index, so a Resend retry or a double-forward of the SAME
-- email still ingests once.
drop index if exists public.uq_clopay_dc_reports_date;
create index if not exists idx_clopay_dc_reports_date on public.clopay_dc_reports (report_date);
