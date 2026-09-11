-- Cassie as a colleague in Google Chat: a team member can message her directly (or mention
-- her outside an ask thread) and she answers — looking up jobs and orders when it is work,
-- just talking when it is not. On by default; the switch is on the Cassie settings page.
alter table public.agent_settings add column if not exists chat_colleague_enabled boolean not null default true;
