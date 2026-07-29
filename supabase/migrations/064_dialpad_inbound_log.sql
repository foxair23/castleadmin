-- Raw log of everything Dialpad POSTs to our inbound SMS webhook.
--
-- Dialpad intercepts STOP/HELP keywords internally and (on this account) does
-- NOT forward them to the webhook, so we can't rely on inbound events alone to
-- capture opt-outs. This table gives visibility into what Dialpad actually
-- sends; the engine also self-heals by recording an opt-out when an outbound
-- send is rejected for opt-out reasons (see lib/invoice-reminders/engine.ts).
create table if not exists public.dialpad_inbound_events (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),
  verified     boolean not null default false,   -- JWT signature verified
  from_number  text,
  message_text text,
  action       text,                              -- opted_out / opted_in / help / noop / unverified / ignored
  raw_body     text
);
create index if not exists idx_dialpad_inbound_received on public.dialpad_inbound_events(received_at desc);

alter table public.dialpad_inbound_events enable row level security;
drop policy if exists "admin_all_dialpad_inbound_events" on public.dialpad_inbound_events;
create policy "admin_all_dialpad_inbound_events" on public.dialpad_inbound_events for all using (public.is_admin());
