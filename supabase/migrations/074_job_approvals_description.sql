-- Snapshot the SF job description onto the approval, so the customer sees the
-- same description of the work on the approval email + signing screen, and it's
-- frozen into the immutable record (SF edits later don't change what they saw).

alter table public.job_approvals
  add column if not exists job_description text;
