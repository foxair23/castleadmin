-- Add sf_job_number to store the human-readable SF job number (e.g. "10042")
alter table public.jobs
  add column if not exists sf_job_number text;
