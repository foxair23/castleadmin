-- Service Fusion "Agent/Rep" assignment on jobs.
-- SF exposes an `agents` array on jobs (id, first_name, last_name) via the
-- `agents` expand. The team uses this field to mark the rep responsible for
-- selling a job, which we use as the basis for commission tracking.
--
-- Mirrors the sf_job_techs pattern: one row per (job, agent), fully replaced
-- on each job sync.

create table if not exists public.sf_job_agents (
  id               uuid primary key default gen_random_uuid(),
  job_id           text not null references public.sf_jobs(id) on delete cascade,
  agent_id         text not null,
  agent_first_name text,
  agent_last_name  text,
  sf_synced_at     timestamptz not null default now(),
  unique (job_id, agent_id)
);

create index if not exists idx_sf_job_agents_job   on public.sf_job_agents(job_id);
create index if not exists idx_sf_job_agents_agent on public.sf_job_agents(agent_id);

alter table public.sf_job_agents enable row level security;

drop policy if exists "admin_all_sf_job_agents" on public.sf_job_agents;
create policy "admin_all_sf_job_agents" on public.sf_job_agents
  for all using (public.is_admin());
