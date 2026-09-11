-- Cassie learns from the conversation. A team member's reply in a Chat ask (or a reviewer's
-- note) can carry two kinds of thing: facts about THIS job or email, and rules for next
-- time. Cassie separates them; the rules become standing instructions she wrote herself,
-- attributed to where she heard them. She may also ask a follow-up question in the thread
-- before she is ready to draft — bounded, so a thread cannot loop.
alter table public.agent_chat_asks add column if not exists follow_ups int not null default 0;
alter table public.agent_chat_asks add column if not exists learned_instructions int not null default 0;
alter table public.agent_chat_asks add column if not exists asked_by text;                 -- a reviewer's name when the ask came from the Review page
alter table public.agent_instructions add column if not exists source text;                -- 'chat:<askId>' | 'review:<replyId>' | null (typed on the page)
