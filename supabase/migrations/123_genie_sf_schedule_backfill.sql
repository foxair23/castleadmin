-- Queue the Genie appointments booked BEFORE migration 122 existed.
--
-- 122 added sf_schedule_status, which the booking route stamps 'queued' at booking time. An
-- order booked before that has an appointment on it and no status — so the extension never
-- sees it, and its date is still not on the SF job. Queue every upcoming appointment that
-- has a job and was never considered. Past appointments are left alone: writing a date that
-- has already come and gone would only confuse the job's history.
--
-- Idempotent: only rows with a null status are touched, so a rerun is a no-op.
update public.vendor_orders
   set sf_schedule_status     = 'queued',
       sf_schedule_job_number = coalesce(sf_schedule_job_number, sf_created_job_number),
       sf_schedule_sync_note  = 'queued by migration 123 (booked before the schedule queue existed)'
 where sf_schedule_status is null
   and sf_job_id is not null
   and appointment_date is not null
   and appointment_date >= current_date;
