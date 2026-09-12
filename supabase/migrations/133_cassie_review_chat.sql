-- A conversation with Cassie about one partner email, on the Review page: the reviewer
-- and Cassie go back and forth (she can look things up, revise the draft, ask the team in
-- Chat, or remember a rule as they talk). Keyed by the inbound MESSAGE, so the thread
-- follows the email across superseded drafts.
create table if not exists public.agent_reply_chat (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.agent_email_messages(id) on delete cascade,
  role        text not null check (role in ('user', 'cassie')),
  text        text not null,
  user_name   text,
  meta        jsonb,                                   -- tools used, revised reply id, ask id, rules learned
  created_at  timestamptz not null default now()
);
create index if not exists idx_agent_reply_chat_message on public.agent_reply_chat (message_id, created_at);
alter table public.agent_reply_chat enable row level security;
drop policy if exists admin_all_agent_reply_chat on public.agent_reply_chat;
create policy admin_all_agent_reply_chat on public.agent_reply_chat for all using (public.is_admin()) with check (public.is_admin());
