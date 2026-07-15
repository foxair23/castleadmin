-- Daily snapshot of the open Action Items backlog, written once each morning by
-- the 7 AM digest cron. Diffing today's snapshot against yesterday's yields the
-- "yesterday's progress" synopsis at the top of the morning email:
--   closed = keys present yesterday, gone today  (resolved in SF)
--   added  = keys present today, absent yesterday (new backlog)
-- item_keys are "tab:id" strings across every action tab.

create table if not exists public.action_item_daily_snapshot (
  snapshot_date date primary key,        -- PT calendar day of the snapshot
  item_keys     jsonb not null default '[]'::jsonb,
  total         integer not null default 0,
  created_at    timestamptz not null default now()
);

-- Service-role only (written/read by the cron with the service key); no RLS
-- policies for anon/authenticated. RLS on keeps it locked down by default.
alter table public.action_item_daily_snapshot enable row level security;
