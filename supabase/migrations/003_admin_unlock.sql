-- Allow admin to unlock a past-deadline week for a technician
alter table public.week_submissions
  add column if not exists admin_unlocked boolean not null default false;
