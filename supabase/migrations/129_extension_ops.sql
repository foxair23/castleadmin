-- Extension observability + remote control.
--
-- The Chrome extension on the office machine is the only thing that crawls the vendor
-- portals and writes into Service Fusion, and until now the app learned nothing about it
-- beyond per-item callbacks: a dead machine was silent. Now the extension reports every
-- run, crawl, login and warm-up here, heartbeats every 10 minutes, and picks up commands
-- the owner queues from the Health page (/admin/ops) — from a phone, if need be.
--
-- ops_health_state holds each health condition's current colour and when it was last
-- alerted, so alerts fire on transitions rather than on every check.

create table if not exists public.extension_heartbeat (
  device          text primary key,             -- 'office-mac', 'office-chromebook', …
  version         text,
  chrome          text,
  last_seen_at    timestamptz not null default now(),
  last_run_at     timestamptz,
  last_run_status text,
  state           jsonb,                        -- config flags, alarms, problems (never credentials)
  updated_at      timestamptz not null default now()
);

create table if not exists public.extension_runs (
  id           uuid primary key default gen_random_uuid(),
  device       text,
  kind         text not null,                   -- heartbeat | run | crawl | login | warm | command
  site         text,                            -- genie | clopay | service_fusion | castle_admin | null
  mode         text,                            -- full | incremental | docs | warm | null
  status       text not null,                   -- started | done | failed | aborted | stalled | budget | ok
  reason       text,
  source       text,                            -- alarm | manual | schedule | command:<id> | sf-recover
  started_at   timestamptz,
  finished_at  timestamptz,
  counts       jsonb,
  log          jsonb,
  version      text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_extension_runs_created on public.extension_runs (created_at desc);
create index if not exists idx_extension_runs_site on public.extension_runs (site, kind, status, finished_at desc);

create table if not exists public.extension_commands (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,                   -- run_now | crawl | relogin | warm | clear_badge | set_config
  args         jsonb not null default '{}'::jsonb,
  status       text not null default 'pending', -- pending | claimed | done | failed
  created_by   uuid,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb
);
create index if not exists idx_extension_commands_status on public.extension_commands (status, created_at);

create table if not exists public.ops_health_state (
  condition        text primary key,
  state            text not null,               -- green | amber | red
  since            timestamptz not null default now(),
  last_alerted_at  timestamptz,
  detail           text,
  updated_at       timestamptz not null default now()
);

alter table public.extension_heartbeat enable row level security;
alter table public.extension_runs enable row level security;
alter table public.extension_commands enable row level security;
alter table public.ops_health_state enable row level security;
drop policy if exists admin_all_extension_heartbeat on public.extension_heartbeat;
create policy admin_all_extension_heartbeat on public.extension_heartbeat for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all_extension_runs on public.extension_runs;
create policy admin_all_extension_runs on public.extension_runs for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all_extension_commands on public.extension_commands;
create policy admin_all_extension_commands on public.extension_commands for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all_ops_health_state on public.ops_health_state;
create policy admin_all_ops_health_state on public.ops_health_state for all using (public.is_admin()) with check (public.is_admin());

-- One notification type for the whole automation: a 7am summary, and an email only when
-- a condition turns red (or recovers). Replaces the per-event automation_alert emails.
insert into public.notification_types (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'automation_health',
  'Automation Health',
  'Daily 7am summary of the office extension, portal crawls and SF queues, plus an email only when something turns red (extension silent, crawl missing, auto-login failed, queue stuck) and when it recovers.',
  'operations',
  array[]::text[],
  false
)
on conflict (key) do nothing;

-- Whoever gets today's automation alerts gets the new type too.
insert into public.user_notification_preferences (user_id, notification_type_id, is_enabled)
select p.user_id, t.id, p.is_enabled
from public.user_notification_preferences p
join public.notification_types o on o.id = p.notification_type_id and o.key = 'automation_alert'
join public.notification_types t on t.key = 'automation_health'
on conflict do nothing;
