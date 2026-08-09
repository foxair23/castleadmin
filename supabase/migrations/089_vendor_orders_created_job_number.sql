-- The SF job number captured at creation time, so HD Orders can show it
-- immediately (as "pending sync", styled differently) before the daily/hourly SF
-- mirror ingests the new job. Once the mirror has it, the normal (matched) number
-- takes over.
alter table public.vendor_orders add column if not exists sf_created_job_number text;
