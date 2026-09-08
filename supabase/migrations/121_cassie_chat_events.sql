-- Cassie — a record of every inbound Google Chat event.
--
-- Until now nothing about a Chat conversation was stored unless it became an answer on an
-- ask: a message Cassie ignored, or one that arrived in an envelope she did not recognise,
-- left no trace anywhere a person can see. That is precisely the case worth seeing — it is
-- how the add-on envelope went unnoticed while the endpoint cheerfully returned 200.
--
-- Every event is written on arrival with what we understood of it, and updated with the
-- outcome once handled. Kept small and pruned by age; this is a diagnostic trail, not a
-- message archive.

create table if not exists public.agent_chat_events (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  event_type    text not null,                 -- MESSAGE / CARD_CLICKED / ADDED_TO_SPACE / unrecognised
  envelope      text not null default 'classic',  -- 'classic' | 'addon'
  space_name    text,
  thread_name   text,
  sender_name   text,
  sender_email  text,
  body          text,                          -- what the person wrote, as we read it
  ask_id        uuid references public.agent_chat_asks (id) on delete set null,
  outcome       text,                          -- what handling decided; null while in flight
  error         text
);

create index if not exists idx_agent_chat_events_received on public.agent_chat_events (received_at desc);
create index if not exists idx_agent_chat_events_ask on public.agent_chat_events (ask_id);

alter table public.agent_chat_events enable row level security;
drop policy if exists admin_all_agent_chat_events on public.agent_chat_events;
create policy admin_all_agent_chat_events on public.agent_chat_events
  for all using (public.is_admin()) with check (public.is_admin());
