-- A team member answered one of Cassie's asks from a NEW top-level message in the space
-- (not in her thread), and the conversation carried on in the thread under their message.
-- Cassie matches the answer to the ask by the PO / job number in it, and then remembers
-- that thread as belonging to the ask, so the rest of the conversation stays connected.
alter table public.agent_chat_asks
  add column if not exists linked_thread_names text[] not null default '{}';
