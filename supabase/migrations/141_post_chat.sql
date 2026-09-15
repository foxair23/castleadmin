-- Reputation Engine: the feedback chat beside a profile post.
-- The office tells the agent what is wrong with a draft or its photos in plain
-- words; the agent relabels photos, blocks them, swaps the post's photos,
-- redrafts, and saves standing rules. The thread is scoped to the JOB, not the
-- post, so it survives a redraft, a skip, or a second post for the same job
-- (same reasoning as agent_reply_chat being keyed to the inbound email).

create table if not exists public.gbp_post_chat (
  id          uuid primary key default gen_random_uuid(),
  sf_job_id   text not null,
  post_id     uuid references public.gbp_posts(id) on delete set null,
  role        text not null check (role in ('user','agent')),
  text        text not null,
  user_name   text,
  meta        jsonb not null default '{}'::jsonb,   -- toolsUsed, changes (for undo), undone_at
  created_at  timestamptz not null default now()
);
create index if not exists idx_gbp_post_chat_job on public.gbp_post_chat(sf_job_id, created_at);

alter table public.gbp_post_chat enable row level security;
drop policy if exists admin_all_gbp_post_chat on public.gbp_post_chat;
create policy admin_all_gbp_post_chat on public.gbp_post_chat for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.gbp_post_chat to service_role;
grant select on public.gbp_post_chat to authenticated;

-- agent_instructions.channel gains the value 'photo': standing rules for the
-- vision scorer that grades job photos (no schema change, the column is free text).
