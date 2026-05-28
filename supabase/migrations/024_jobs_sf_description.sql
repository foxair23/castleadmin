-- Store the SF job description on the piecework jobs row so it
-- shows alongside piecework entries without needing a separate lookup.

alter table public.jobs add column if not exists sf_description text;
