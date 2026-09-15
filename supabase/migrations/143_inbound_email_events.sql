-- One line for every inbound email, whatever happens to it.
--
-- Three inbound routes share one receiving domain and route by local-part. Until now only
-- the LEAD and Clopay-DC paths left a trace: a forwarded remittance or STS order that
-- arrived and worked wrote nothing here, and a post rejected on a stale token wrote nothing
-- anywhere. So "never arrived", "arrived and was rejected" and "arrived and worked fine"
-- all looked identical from the database — which is how a morning was spent checking DNS
-- for mail that may well have been delivered.
--
-- Deliberately separate from leadgen_inbound_events, which the Lead Gen pages display;
-- remittance and STS rows do not belong in that view.
create table if not exists public.inbound_email_events (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  route           text not null,          -- leads | remittance | clopay_sts | clopay_dc | rejected | unknown
  recipient       text,                   -- what it was addressed to: the thing that decides the route
  from_addr       text,
  subject         text,
  resend_email_id text,
  ok              boolean,
  detail          text
);

create index if not exists idx_inbound_email_events_received
  on public.inbound_email_events (received_at desc);
create index if not exists idx_inbound_email_events_route
  on public.inbound_email_events (route, received_at desc);

alter table public.inbound_email_events enable row level security;
drop policy if exists admin_all_inbound_email_events on public.inbound_email_events;
create policy admin_all_inbound_email_events on public.inbound_email_events
  for all using (public.is_admin()) with check (public.is_admin());
