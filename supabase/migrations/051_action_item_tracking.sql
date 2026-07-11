-- Action Items tracking: record the (single) action taken on an item and when
-- to follow up. One row per item — pressing the action button again (e.g. a
-- second payment request) overwrites and restarts the follow-up clock.
-- Resolution stays automatic: items leave the tabs when the SF mirror shows
-- them resolved; this table only tracks the "actioned, waiting" middle state.

create table if not exists public.action_item_actions (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null,
  entity_id     text not null,
  action_label  text not null,
  actioned_by   uuid references public.profiles(id) on delete set null,
  actioned_at   timestamptz not null default now(),
  follow_up_on  date not null,
  unique (entity_type, entity_id)
);
create index if not exists idx_action_item_actions_followup
  on public.action_item_actions (follow_up_on);

alter table public.action_item_actions enable row level security;

-- Same access as action_item_notes: admins manage; writes go through the
-- role-checked API using the service role.
drop policy if exists "admin_all_action_item_actions" on public.action_item_actions;
create policy "admin_all_action_item_actions" on public.action_item_actions
  for all using (public.is_admin());

-- ── Daily to-do digest notification type ────────────────────────────────────
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'daily_action_items_todo',
  'Daily Action Items To-Do',
  'Weekday-morning email listing action items needing a first touch and follow-ups due today',
  'operations',
  array['admin','sales'],
  false
)
on conflict (key) do nothing;
