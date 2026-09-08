-- Cassie — regression runs (PRD §10 drift detection, §14 Phase-2 prerequisite).
-- agent_regression_cases (115) holds the saved inquiries with known-correct replies;
-- this records each on-demand run so results can be compared across model, prompt
-- and charter versions. Auto-Respond cannot be enabled until a run with ≥ 30 cases exists.

create table if not exists public.agent_regression_runs (
  id               uuid primary key default gen_random_uuid(),
  ran_at           timestamptz not null default now(),
  ran_by           uuid references auth.users(id),
  model            text,
  classifier_model text,
  prompt_version   int,
  charter_version  int,
  cases            int not null default 0,
  passed           int not null default 0,
  mean_score       numeric(5,3),
  results          jsonb not null default '[]'::jsonb,   -- [{case_id, name, score, passed, grounded, unsourced[], produced_text, missing_values[]}]
  note             text
);
create index if not exists idx_agent_regression_runs_ran on public.agent_regression_runs (ran_at desc);

alter table public.agent_regression_runs enable row level security;
drop policy if exists admin_all_agent_regression_runs on public.agent_regression_runs;
create policy admin_all_agent_regression_runs on public.agent_regression_runs for all
  using (public.is_admin()) with check (public.is_admin());

-- Where a case came from, so it can be traced back.
alter table public.agent_regression_cases add column if not exists source_reply_id uuid references public.agent_email_replies(id) on delete set null;
alter table public.agent_regression_cases add column if not exists question_type text;
alter table public.agent_regression_cases add column if not exists sf_job_number text;
