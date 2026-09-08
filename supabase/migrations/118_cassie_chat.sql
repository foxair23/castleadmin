-- Cassie — Google Chat assist bookkeeping (PRD §11). agent_chat_asks was created in
-- 115; this adds what the interaction loop needs: the card we posted (so it can be
-- updated in place), the reply composed from the team's answer, and the edit handshake.

alter table public.agent_chat_asks add column if not exists draft_reply_id uuid references public.agent_email_replies(id) on delete set null;
alter table public.agent_chat_asks add column if not exists draft_card_name text;      -- Chat resource name of the draft card
alter table public.agent_chat_asks add column if not exists awaiting_edit boolean not null default false;
alter table public.agent_chat_asks add column if not exists responder_id text;         -- Chat user resource name
alter table public.agent_chat_asks add column if not exists dedupe_key text;           -- thread / question fingerprint
create index if not exists idx_agent_chat_asks_dedupe on public.agent_chat_asks (dedupe_key, posted_at desc);

alter table public.agent_email_replies add column if not exists chat_ask_id uuid references public.agent_chat_asks(id) on delete set null;
