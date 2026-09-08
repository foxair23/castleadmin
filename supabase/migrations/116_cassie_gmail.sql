-- Cassie — Gmail mailbox credential (PRD §4). One row: the OAuth refresh token for
-- cassie@castlegarage.com, granted once by an admin from Admin → Cassie → Settings.
-- Stored server-side like crm_tokens; only the service role reads it. Reconnecting
-- replaces the row. GMAIL_REFRESH_TOKEN in the environment remains a fallback.

create table if not exists public.agent_gmail_credentials (
  id             int primary key default 1 check (id = 1),
  email          text not null,                 -- the Google account that granted access
  refresh_token  text not null,
  scopes         text[] not null default '{}',
  granted_by     uuid references auth.users(id),
  granted_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

alter table public.agent_gmail_credentials enable row level security;
drop policy if exists admin_all_agent_gmail_credentials on public.agent_gmail_credentials;
create policy admin_all_agent_gmail_credentials on public.agent_gmail_credentials for all
  using (public.is_admin()) with check (public.is_admin());

-- Outbound bookkeeping on the reply row.
alter table public.agent_email_replies add column if not exists gmail_sent_thread_id text;
alter table public.agent_email_replies add column if not exists send_attempts int not null default 0;
alter table public.agent_email_replies add column if not exists last_send_error text;
