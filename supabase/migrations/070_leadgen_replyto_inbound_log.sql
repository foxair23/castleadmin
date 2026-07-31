-- LeadGen refinements for sharing updates.castlegaragedoors.com as the receiving
-- domain (send + receive on one subdomain).

-- 1) Reply-To for outreach. The outreach email invites the customer to reply,
--    but it's sent from noreply@updates… — and now that updates… receives into
--    our inbound webhook, replies would be swallowed by the parser. Route them
--    to a real monitored mailbox instead. (Leave blank to send with no Reply-To.)
alter table public.leadgen_settings
  add column if not exists reply_to_email text;

-- 2) Inbound event log. The shared domain funnels every reply/bounce to
--    @updates… into the webhook; log what arrives so odd/failed cases are
--    visible (and the first-run dry test is debuggable).
create table if not exists public.leadgen_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  from_addr       text,
  subject         text,
  resend_email_id text,
  outcome         text not null,          -- ingested | duplicate | held | no_contact | not_lead | fetch_failed | error | ignored
  lead_id         uuid,
  detail          text
);
create index if not exists idx_leadgen_inbound_received on public.leadgen_inbound_events(received_at desc);

alter table public.leadgen_inbound_events enable row level security;
drop policy if exists "staff_all_leadgen_inbound_events" on public.leadgen_inbound_events;
create policy "staff_all_leadgen_inbound_events" on public.leadgen_inbound_events for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','sales')));
