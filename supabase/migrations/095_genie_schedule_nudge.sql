-- Genie "please schedule your install" nudge: a one-time email + SMS sent to the
-- customer once we've created their SF job, pointing them at the self-scheduler.
-- Mirrors the LeadGen outreach + the Genie autopilot's new-only cutoff.

-- Idempotency stamp on the order (mirrors action_done_at / scheduled_at).
alter table public.vendor_orders
  add column if not exists schedule_nudge_sent_at  timestamptz,
  add column if not exists schedule_nudge_channels text;   -- e.g. 'email,sms'

-- Settings + on/off toggle, mirroring vendor_autopilot (091) plus the link.
-- enabled_at is stamped each time it's turned ON, so enabling never sweeps the
-- historical backlog. schedule_url is the customer-facing scheduler page.
create table if not exists public.vendor_schedule_nudge (
  vendor       text primary key,
  enabled      boolean not null default false,
  enabled_at   timestamptz,
  schedule_url text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)
);

alter table public.vendor_schedule_nudge enable row level security;
drop policy if exists "admin_all_vendor_schedule_nudge" on public.vendor_schedule_nudge;
create policy "admin_all_vendor_schedule_nudge" on public.vendor_schedule_nudge for all using (public.is_admin());
