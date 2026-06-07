-- Add time window columns to sf_jobs so per-window capacity checks can match
-- SF jobs against the scheduler's time windows.
alter table public.sf_jobs
  add column if not exists time_frame_promised_start text,
  add column if not exists time_frame_promised_end   text;

-- Backfill from stored raw_data (populated if SF returns these at the job level)
update public.sf_jobs
  set time_frame_promised_start = raw_data->>'time_frame_promised_start',
      time_frame_promised_end   = raw_data->>'time_frame_promised_end'
  where raw_data is not null
    and (raw_data->>'time_frame_promised_start' is not null
      or raw_data->>'time_frame_promised_end'   is not null);

create index if not exists idx_sf_jobs_date_tfps
  on public.sf_jobs(start_date, time_frame_promised_start)
  where is_deleted = false;
