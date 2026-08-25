-- Genie self-scheduler funnel instrumentation. Zero of 27 nudged customers have
-- ever self-scheduled, and the link works — so they drop off somewhere in the
-- flow. This logs an anonymous per-visit funnel (start → lookup → confirm →
-- qualify → schedule → book) so we can see exactly where, and whether the
-- scheduling screen shows no slots / only far-out dates (the "7 days is too long,
-- so they call" hypothesis). Session id is client-generated (no PII).

create table if not exists public.genie_funnel_events (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null,               -- anonymous per-visit id (client-generated)
  step         text not null,               -- 'start' | 'lookup_attempt' | 'lookup_found' | 'lookup_not_found'
                                             -- | 'reached_qualification' | 'qualification_done'
                                             -- | 'reached_scheduling' | 'saw_zero_slots' | 'selected_slot' | 'booked'
  order_number text,                         -- HD order # once known (nullable pre-lookup)
  detail       jsonb not null default '{}',  -- e.g. { earliest_date, bookable_count, lead_days, horizon }
  at           timestamptz not null default now()
);
create index if not exists idx_genie_funnel_session on public.genie_funnel_events (session_id, at);
create index if not exists idx_genie_funnel_step_at on public.genie_funnel_events (step, at);

-- Admin-readable; writes happen via the service role in the track route.
alter table public.genie_funnel_events enable row level security;
drop policy if exists "admin_all_genie_funnel_events" on public.genie_funnel_events;
create policy "admin_all_genie_funnel_events" on public.genie_funnel_events for all using (public.is_admin());
