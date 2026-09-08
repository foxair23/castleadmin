-- Cassie — match a Chat reply to its ask by the thread's RESOURCE NAME.
--
-- We post with a thread_key we choose, but Google echoes back only the thread's resource
-- name (spaces/X/threads/T) on inbound events; the key is not returned. Matching on the
-- key therefore fell through to a space-prefix guess, which with two open asks in the
-- same space could attach an answer to the wrong partner's question. Storing the name
-- Google gives us when the card is posted makes the match exact, and works whether the
-- space uses threaded replies or in-line threading.

alter table public.agent_chat_asks add column if not exists chat_thread_name text;
create index if not exists idx_agent_chat_asks_thread_name on public.agent_chat_asks (chat_thread_name);
