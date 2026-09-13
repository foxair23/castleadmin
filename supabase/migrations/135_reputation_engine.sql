-- Reputation Engine, Phase 1 (PRD: castle-prd-reputation.md §3, §4, §5.2, §9).
--
-- Adds: CSAT 2-day reminders + per-customer review links; the AI review reply
-- agent (review_replies) with two autopilot switches; one humanized outbound
-- send queue shared by replies, reminders and (Phase 2) profile posts; AI tags
-- on every Google review; and a channel column on the Cassie knowledge tables so
-- the reply agent can have its own charter / instructions / style examples
-- without touching Cassie's.
--
-- Safety posture: both autopilot switches default OFF, so every draft waits for
-- a person until an admin flips them. draft_since defaults to now() so the first
-- cron after deploy does not draft replies for every historical review — those
-- only happen through the "Draft replies for old reviews" button.
--
-- updated_at columns are maintained by application code (no triggers), as
-- everywhere else in this schema.

-- ── CSAT reminders ────────────────────────────────────────────────────────────
alter table public.csat_settings add column if not exists reminder_delay_hours int not null default 48;
alter table public.csat_settings add column if not exists survey_reminder_sms text not null default
  'Castle Garage Doors: Just checking in — how satisfied were you with your recent service? Reply with a number from 1 to 5 (5 = Very Satisfied). Reply STOP to opt out.';
alter table public.csat_settings add column if not exists review_reminder_sms text not null default
  'Thanks again for choosing Castle! If you have a minute, a quick Google review helps our family-owned business a lot: {{review_url}}';

alter table public.csat_surveys add column if not exists survey_reminder_sent_at timestamptz;
alter table public.csat_surveys add column if not exists review_reminder_sent_at timestamptz;
alter table public.csat_surveys add column if not exists review_short_code      text;        -- short_links.code for this survey's review link
alter table public.csat_surveys add column if not exists review_link_clicked_at timestamptz; -- stamped by /r/<surveyId>

create index if not exists idx_csat_surveys_survey_reminder on public.csat_surveys(sent_at)
  where survey_reminder_sent_at is null and status = 'sent';
create index if not exists idx_csat_surveys_review_reminder on public.csat_surveys(review_requested_at)
  where review_reminder_sent_at is null and review_link_clicked_at is null;

-- ── google_reviews: reply provenance + AI tags ────────────────────────────────
alter table public.google_reviews add column if not exists reply_source text
  check (reply_source in ('agent','manual','pre_existing'));
alter table public.google_reviews add column if not exists ai_sentiment       text;
alter table public.google_reviews add column if not exists ai_themes          text[] not null default '{}';
alter table public.google_reviews add column if not exists ai_service_tags    text[] not null default '{}';
alter table public.google_reviews add column if not exists ai_mentioned_names text[] not null default '{}';
alter table public.google_reviews add column if not exists ai_neighborhood    text;
alter table public.google_reviews add column if not exists ai_tagged_at       timestamptz;
alter table public.google_reviews add column if not exists ai_tag_model       text;

create index if not exists idx_google_reviews_untagged on public.google_reviews(ingested_at)
  where ai_tagged_at is null and deleted_at is null;
create index if not exists idx_google_reviews_unreplied on public.google_reviews(ingested_at)
  where reply_text is null and deleted_at is null;

-- Replies that were already on Google before the agent existed.
update public.google_reviews set reply_source = 'pre_existing'
  where reply_text is not null and reply_source is null;

-- ── Cassie knowledge tables: one charter per channel ─────────────────────────
alter table public.agent_charter add column if not exists channel text not null default 'email';  -- 'email' | 'review' | 'post'
alter table public.agent_charter drop constraint if exists agent_charter_version_key;             -- was unique(version)
create unique index if not exists agent_charter_channel_version on public.agent_charter(channel, version);
drop index if exists public.agent_charter_one_active;
create unique index if not exists agent_charter_one_active_per_channel on public.agent_charter(channel) where is_active;

-- agent_instructions.channel (text) gains the value 'review'; agent_style_examples.audience
-- (text) gains 'review_positive' / 'review_negative'. No DDL needed for either.
alter table public.agent_style_examples add column if not exists google_review_id uuid;  -- dedupe key for imported Google replies
create index if not exists idx_agent_style_examples_google_review on public.agent_style_examples(google_review_id)
  where google_review_id is not null;

-- ── reputation_settings (single row) ─────────────────────────────────────────
create table if not exists public.reputation_settings (
  id                        int primary key default 1 check (id = 1),

  -- Autopilot switches (PRD §4.3). Off = drafts wait for a person.
  autopilot_positive        boolean not null default false,   -- 4–5 star replies
  autopilot_negative        boolean not null default false,   -- 1–3 star replies
  sends_paused              boolean not null default false,   -- stops the dispatcher; nothing is lost

  reply_signature           text not null default 'Castle team',

  -- Humanized send timing (PRD §4.5). Window is minutes-of-day PT per weekday; null = closed.
  reply_delay_min_hours     numeric(5,2) not null default 1,
  reply_delay_max_hours     numeric(5,2) not null default 6,
  working_window            jsonb not null default
    '{"mon":[460,1100],"tue":[460,1100],"wed":[460,1100],"thu":[460,1100],"fri":[460,1100],"sat":[510,850],"sun":null}'::jsonb,
  min_gap_minutes           int not null default 20,
  max_gap_minutes           int not null default 90,
  skip_hour_ratio           numeric(4,3) not null default 0.250,
  cap_new_replies           int not null default 8,
  cap_backlog_replies       int not null default 3,
  cap_posts                 int not null default 1,

  ingest_interval_minutes   int not null default 30,
  draft_since               timestamptz not null default now(),  -- reviews ingested before this are backlog-only
  pre_existing_imported_at  timestamptz,                          -- one-time import of Castle's existing replies as style examples
  prompt_version            int not null default 1,

  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users(id)
);
insert into public.reputation_settings (id) values (1) on conflict (id) do nothing;

-- ── review_replies ───────────────────────────────────────────────────────────
create table if not exists public.review_replies (
  id                 uuid primary key default gen_random_uuid(),
  google_review_id   uuid not null references public.google_reviews(id) on delete cascade,
  band               text not null check (band in ('positive','negative')),
  origin             text not null default 'new' check (origin in ('new','backlog')),
  draft_text         text not null,
  final_text         text,
  status             text not null default 'draft'
    check (status in ('draft','approved','scheduled','posted','verified','skipped','failed')),
  guardrail_notes    jsonb not null default '{}'::jsonb,   -- {passed, attempts, failures:[{check,detail}], previous_drafts:[], model_notes}
  model              text,
  prompt_version     int,
  charter_version    int,
  style_example_ids  uuid[] not null default '{}',
  linked_post_id     uuid,                                  -- Phase 2: gbp_posts.id
  approved_by        uuid references auth.users(id),        -- null + approved_at set = autopilot
  approved_at        timestamptz,
  scheduled_for      timestamptz,
  sent_at            timestamptz,
  verified_at        timestamptz,
  push_reasons       text[] not null default '{}',
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_review_replies_review on public.review_replies(google_review_id);
create index if not exists idx_review_replies_status on public.review_replies(status, created_at desc);
-- One live reply per review. Skipped/failed/verified rows may pile up; live ones may not.
create unique index if not exists review_replies_one_live on public.review_replies(google_review_id)
  where status in ('draft','approved','scheduled','posted');

-- ── outbound_queue (the dispatcher) ──────────────────────────────────────────
create table if not exists public.outbound_queue (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('review_reply','gbp_post','csat_reminder')),
  ref_id         uuid not null,                              -- review_replies.id / gbp_posts.id / csat_surveys.id
  location_id    text,
  priority       int not null default 5,                     -- 1 = first
  origin         text,                                       -- 'new' | 'backlog' for replies
  band           text,                                       -- 'positive' | 'negative' for replies
  payload        jsonb not null default '{}'::jsonb,         -- csat_reminder: {"reminder":"survey"|"review"}
  earliest_at    timestamptz not null default now(),
  scheduled_for  timestamptz not null,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  status         text not null default 'queued'
    check (status in ('queued','sending','sent','failed','cancelled')),
  attempts       int not null default 0,
  push_reasons   text[] not null default '{}',               -- why scheduled_for is later than earliest_at
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_outbound_queue_due on public.outbound_queue(scheduled_for)
  where status in ('queued','sending');
create index if not exists idx_outbound_queue_ref on public.outbound_queue(kind, ref_id);
create index if not exists idx_outbound_queue_sent on public.outbound_queue(sent_at desc) where status = 'sent';

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Admins can do everything through the anon key (is_admin()); server code uses the
-- service role. Grants are explicit so a project with altered default privileges
-- cannot block the cron.
do $$ declare t text; begin
  foreach t in array array['reputation_settings','review_replies','outbound_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;
