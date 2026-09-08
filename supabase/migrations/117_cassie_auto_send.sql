-- Cassie — auto-send routing record (PRD §6.3). Every draft records the auto-send
-- decision taken at compose time: which blockers applied (empty = it queued itself).
-- Kept separate from hard_fail_reasons (grounding/match failures) so the review panel
-- can show "would not auto-send because…" for settings reasons too.

alter table public.agent_email_replies add column if not exists auto_send_blockers text[] not null default '{}';
alter table public.agent_email_replies add column if not exists auto_evaluated_at timestamptz;
alter table public.agent_email_replies add column if not exists recomposed_from uuid references public.agent_email_replies(id) on delete set null;
