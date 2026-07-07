-- Commission note tokens — techs tag a job for commission by writing $token$
-- (e.g. $kyle$) in the job's Tech Notes or Completion Notes in Service Fusion.
-- A token, when present, takes precedence over the Agent field; jobs without a
-- token fall back to agent attribution as before.

create table if not exists public.commission_note_tokens (
  id           uuid primary key default gen_random_uuid(),
  tech_user_id uuid not null references public.profiles(id) on delete cascade,
  token        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Tokens are matched case-insensitively and must be globally unique.
create unique index if not exists uq_commission_note_tokens_token
  on public.commission_note_tokens (lower(token));
create index if not exists idx_commission_note_tokens_tech
  on public.commission_note_tokens (tech_user_id);

alter table public.commission_note_tokens enable row level security;

-- Admin-only (configuration), same as the agent map.
drop policy if exists "admin_all_commission_note_tokens" on public.commission_note_tokens;
create policy "admin_all_commission_note_tokens" on public.commission_note_tokens
  for all using (public.is_admin());

-- ── Extend review_reason for token-based review outcomes ────────────────────
-- The inline CHECK from migration 041 must be dropped and recreated.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT constraint_name INTO cname
  FROM information_schema.table_constraints
  WHERE table_schema = 'public'
    AND table_name   = 'commission_job_eligibility'
    AND constraint_type = 'CHECK'
    AND constraint_name LIKE '%review_reason%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.commission_job_eligibility DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.commission_job_eligibility
  ADD CONSTRAINT commission_job_eligibility_review_reason_check
  CHECK (review_reason IS NULL OR review_reason IN
    ('multiple_agents','unmapped_agent','multiple_tokens','unmapped_token'));
