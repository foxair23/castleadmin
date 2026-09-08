-- Cassie — Castle's AI agent. Data model for the email status channel plus the
-- SHARED agent services (charter, answer library, standing instructions, style
-- corpus, settings) that every future channel (phone) must consume rather than
-- reimplement. PRD: Castle_Email_Status_Agent_PRD.md §13; charter: Cassie spec.
--
-- Naming: shared services are agent_*; the email channel is agent_email_*.
-- (PRD's indicative email_agent_* names map 1:1.)
--
-- Safety posture baked into defaults: processing OFF, auto-respond OFF, the
-- auto-send focus area limited to the four status question types, and only the
-- PO match tier eligible for auto-send. Nothing sends until an admin turns it on.

-- ── Settings (single row) ───────────────────────────────────────────────────
create table if not exists public.agent_settings (
  id                        int primary key default 1 check (id = 1),

  -- Kill switches (PRD §12 Settings)
  processing_enabled        boolean not null default false,  -- global: off = no fetch, no drafts, nothing
  auto_respond_enabled      boolean not null default false,  -- master Auto-Respond switch (off = everything is a draft)

  -- Mailbox / identity (PRD §4; domain moved to castlegarage.com)
  mailbox_address           text not null default 'cassie@castlegarage.com',
  from_display_name         text not null default 'Cassie (Castle AI Agent)',
  reply_to_email            text,                             -- null → officeEmail() from lib/config/domains
  cc_office                 boolean not null default true,
  signature_text            text not null default 'This answer was composed by Cassie, Castle Garage Doors & Gates'' AI Agent.',
  escape_hatch_text         text not null default 'Reply to this email and a member of our team will pick it up.',

  -- Perimeter (PRD §5 Stage 2) — empty allowlist means NOTHING is processed
  allowlist_domains         text[] not null default '{}',     -- e.g. {homedepot.com, clopay.com}
  allowlist_addresses       text[] not null default '{}',     -- individual senders outside those domains
  blocklist_addresses       text[] not null default '{}',

  -- Auto-send controls (PRD §6.3)
  confidence_threshold      numeric(4,3) not null default 0.900,
  auto_question_types       text[] not null default '{schedule,completion,tech,status}',
  auto_match_tiers          text[] not null default '{po}',   -- 'po' | 'name'
  hold_minutes              int not null default 12,
  staleness_minutes         int not null default 5,
  closed_window_days        int not null default 60,
  paused_tiers              jsonb not null default '{}'::jsonb, -- {"<type>:<tier>": {"since":..., "rate":...}} auto-reverted by confusion rate

  -- Outcome monitoring (PRD §10)
  confusion_threshold       numeric(4,3) not null default 0.200,
  confusion_min_sample      int not null default 10,

  -- Google Chat assist (PRD §11)
  chat_space_name           text,                             -- 'spaces/AAAA...'
  chat_timeout_minutes      int not null default 30,
  chat_max_asks_per_hour    int not null default 6,

  -- Escalation (PRD §16 Q5) — app users subscribe via the cassie_escalation
  -- notification type; this adds non-user inboxes.
  escalation_extra_emails   text[] not null default '{}',

  -- Models
  composer_model            text not null default 'claude-sonnet-5',
  classifier_model          text not null default 'claude-haiku-4-5',
  prompt_version            int not null default 1,

  -- Gmail credential health (PRD §4 Authentication)
  gmail_last_ok_at          timestamptz,
  gmail_last_error          text,
  gmail_last_error_at       timestamptz,
  gmail_history_id          text,                             -- incremental fetch cursor

  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users(id)
);
insert into public.agent_settings (id) values (1) on conflict (id) do nothing;

-- ── Charter (PRD §7) — one editable document, versioned ─────────────────────
create table if not exists public.agent_charter (
  id          uuid primary key default gen_random_uuid(),
  version     int not null,
  body        text not null,
  note        text,                                           -- what changed
  is_active   boolean not null default false,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (version)
);
create unique index if not exists agent_charter_one_active on public.agent_charter (is_active) where is_active;

-- ── Standing instructions (PRD §9.2) ────────────────────────────────────────
create table if not exists public.agent_instructions (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  channel     text not null default 'all',                    -- 'all' | 'email' | 'phone'
  is_active   boolean not null default true,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  retired_at  timestamptz,
  retired_by  uuid references auth.users(id)
);

-- ── Curated answer library (PRD §9.3) — counts as GROUNDED ──────────────────
create table if not exists public.agent_answer_library (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  question_examples   text[] not null default '{}',           -- phrasings this answers
  question_type       text,                                   -- classifier type it covers
  answer_text         text not null,
  audience            text not null default 'partner',        -- 'partner' | 'customer' | 'all'
  is_active           boolean not null default true,
  source_chat_ask_id  uuid,                                   -- promoted from a Chat answer
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id)
);

-- ── Style corpus (PRD §9.1) ─────────────────────────────────────────────────
create table if not exists public.agent_style_examples (
  id             uuid primary key default gen_random_uuid(),
  source         text not null,                               -- 'seed' | 'staff' | 'human_edit' | 'human_approved'
  audience       text not null default 'partner',
  question_type  text,
  inquiry_text   text,                                        -- what was asked
  ai_text        text,                                        -- what Cassie drafted (null for staff/seed)
  final_text     text not null,                               -- what actually went out
  reply_id       uuid,                                        -- agent_email_replies.id when learned from a reply
  is_pinned      boolean not null default false,
  is_deleted     boolean not null default false,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

-- ── Inbound / outbound messages (PRD §13 email_agent_messages) ──────────────
create table if not exists public.agent_email_messages (
  id                   uuid primary key default gen_random_uuid(),
  gmail_message_id     text unique,                            -- null only for 'replay' test messages
  gmail_thread_id      text,
  internet_message_id  text,                                  -- Message-ID header
  in_reply_to          text,
  references_ids       text[] not null default '{}',
  direction            text not null default 'inbound',       -- 'inbound' | 'outbound_agent' | 'outbound_human'
  delivery_path        text,                                  -- 'distribution' | 'direct' | 'replay'
  from_addr            text,
  from_name            text,
  from_domain          text,
  to_addrs             text[] not null default '{}',
  cc_addrs             text[] not null default '{}',
  subject              text,
  snippet              text,
  body_text            text,
  headers              jsonb not null default '{}'::jsonb,    -- the auto-reply / precedence headers we filtered on
  received_at          timestamptz,
  -- Processing outcome (every message gets one, even drops — PRD §5 Stage 1 "log every message")
  outcome              text,                                  -- dropped_* | drafted | queued | partner_reply | human_reply | error | skipped
  outcome_detail       text,
  processed_at         timestamptz,
  created_at           timestamptz not null default now()
);
create index if not exists idx_agent_email_messages_thread on public.agent_email_messages (gmail_thread_id);
create index if not exists idx_agent_email_messages_received on public.agent_email_messages (received_at desc);
create index if not exists idx_agent_email_messages_from on public.agent_email_messages (from_addr);

-- ── Composed replies (PRD §13 email_agent_replies) ──────────────────────────
create table if not exists public.agent_email_replies (
  id                    uuid primary key default gen_random_uuid(),
  message_id            uuid not null references public.agent_email_messages(id) on delete cascade,
  gmail_thread_id       text,

  -- What was asked (PRD §5 Stage 3)
  question_type         text,                                 -- schedule | completion | tech | status | ship_date | pricing | warranty | reschedule | complaint | multi | other
  question_summary      text,
  identifiers           jsonb not null default '{}'::jsonb,   -- {pos:[], customerName, email, phone}

  -- Resolution (lib/agent/job-resolver)
  resolve_status        text,                                 -- matched | ambiguous | none
  resolve_tier          text,                                 -- po | name | email | phone
  sf_job_id             text,
  sf_job_number         text,
  live_facts            jsonb,                                -- LiveJobFacts the reply was composed from
  live_fetched_at       timestamptz,

  -- Composition
  composed_subject      text,
  composed_text         text,                                 -- what Cassie wrote
  sent_text             text,                                 -- what actually went out (differs if edited)
  was_edited            boolean not null default false,
  claims                jsonb not null default '[]'::jsonb,   -- [{text, source_ids[], grounded}]
  unsourced_claims      text[] not null default '{}',         -- PRD §12: listed explicitly and separately
  applied_instruction_ids uuid[] not null default '{}',
  style_example_ids     uuid[] not null default '{}',
  answer_library_ids    uuid[] not null default '{}',
  charter_version       int,
  model                 text,
  prompt_version        int,

  -- Routing + confidence (PRD §6.3) — deterministic, not the model's opinion
  confidence            numeric(4,3),
  confidence_breakdown  jsonb not null default '{}'::jsonb,   -- {match, coverage, grounding, freshness}
  hard_fail_reasons     text[] not null default '{}',         -- ungrounded | multi_match | no_match | refresh_failed | type_not_auto | tier_not_auto | auto_off | human_replied
  status                text not null default 'draft',        -- draft | queued | sent | cancelled | superseded | rejected | escalated | failed
  send_after            timestamptz,                          -- hold window end (queued only)
  sent_at               timestamptz,
  gmail_sent_message_id text,
  approval_path         text,                                 -- auto | approved | edited | chat_approved
  approved_by           uuid references auth.users(id),
  approved_at           timestamptz,
  rejected_by           uuid references auth.users(id),
  rejected_at           timestamptz,
  cancel_reason         text,                                 -- human_replied | facts_changed | kill_switch | ...
  error                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_agent_email_replies_status on public.agent_email_replies (status, send_after);
create index if not exists idx_agent_email_replies_thread on public.agent_email_replies (gmail_thread_id);
create index if not exists idx_agent_email_replies_job on public.agent_email_replies (sf_job_id);
create index if not exists idx_agent_email_replies_created on public.agent_email_replies (created_at desc);

-- ── Source attribution (PRD §12) — retained indefinitely ────────────────────
create table if not exists public.agent_email_sources (
  id            uuid primary key default gen_random_uuid(),
  reply_id      uuid not null references public.agent_email_replies(id) on delete cascade,
  source_type   text not null,                                -- sf_job | vendor_order | answer_library | instruction | style_example | charter | thread_message | chat_answer | model
  ref_id        text,                                         -- job id, library row id, message id, ...
  ref_label     text,                                         -- human label ("Job 1020259225")
  fields        jsonb not null default '{}'::jsonb,           -- the exact values used
  retrieved_at  timestamptz not null default now()
);
create index if not exists idx_agent_email_sources_reply on public.agent_email_sources (reply_id);

-- ── Google Chat asks (PRD §11) ──────────────────────────────────────────────
create table if not exists public.agent_chat_asks (
  id                   uuid primary key default gen_random_uuid(),
  reply_id             uuid references public.agent_email_replies(id) on delete set null,
  message_id           uuid references public.agent_email_messages(id) on delete set null,
  space_name           text,
  thread_key           text,
  chat_message_name    text,                                  -- Chat API resource name of our post
  question             text not null,                         -- the specific thing Cassie is missing
  status               text not null default 'open',          -- open | answered | composed | approved | sent_to_review | timed_out | cancelled
  posted_at            timestamptz not null default now(),
  reminded_at          timestamptz,
  responder_name       text,
  responder_email      text,
  response_text        text,
  responded_at         timestamptz,
  promoted_library_id  uuid references public.agent_answer_library(id) on delete set null,
  resolved_at          timestamptz
);
create index if not exists idx_agent_chat_asks_status on public.agent_chat_asks (status, posted_at);

-- ── Feedback (PRD §12 queue + post-send) ────────────────────────────────────
create table if not exists public.agent_email_feedback (
  id          uuid primary key default gen_random_uuid(),
  reply_id    uuid not null references public.agent_email_replies(id) on delete cascade,
  kind        text not null,                                  -- edit | reject | post_send | confused
  note        text not null,
  user_id     uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

-- ── Partner reply outcomes (PRD §10) ────────────────────────────────────────
create table if not exists public.agent_email_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  reply_id            uuid not null references public.agent_email_replies(id) on delete cascade,
  partner_message_id  uuid references public.agent_email_messages(id) on delete set null,
  classification      text not null,                          -- resolved | confused | new_question
  classified_by       text not null default 'model',          -- model | human
  reason              text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_agent_email_outcomes_reply on public.agent_email_outcomes (reply_id);

-- ── Coverage demand log (PRD §9.4) ──────────────────────────────────────────
create table if not exists public.agent_coverage_log (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid references public.agent_email_messages(id) on delete set null,
  question_type  text not null,
  missing        text not null,                               -- what Cassie needed and did not have
  created_at     timestamptz not null default now()
);

-- ── Regression cases (PRD §10 drift detection; prerequisite for Phase 2) ────
create table if not exists public.agent_regression_cases (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  inbound_text    text not null,
  inbound_from    text,
  identifiers     jsonb not null default '{}'::jsonb,
  facts_fixture   jsonb,                                      -- LiveJobFacts to inject (so runs never hit SF)
  expected_text   text not null,
  is_active       boolean not null default true,
  last_run_at     timestamptz,
  last_result     jsonb,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

-- ── RLS: admin-only everywhere; server code uses the service role ───────────
do $$
declare t text;
begin
  foreach t in array array[
    'agent_settings','agent_charter','agent_instructions','agent_answer_library','agent_style_examples',
    'agent_email_messages','agent_email_replies','agent_email_sources','agent_chat_asks',
    'agent_email_feedback','agent_email_outcomes','agent_coverage_log','agent_regression_cases'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
  end loop;
end $$;

-- ── Notification types (internal alerts go through Resend, never partner mail) ─
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values
  ('cassie_escalation', 'Cassie: Thread Escalated',
   'Cassie could not answer a partner email on her own and handed the thread to the team — includes the partner''s question, the matched job (if any), and a link to the review queue item.',
   'operations', array['admin']::text[], false),
  ('cassie_credential_failure', 'Cassie: Mailbox Connection Failed',
   'Cassie''s Gmail connection is failing (expired or revoked authorization). Processing has stopped until it is re-authorized under Integrations.',
   'operations', array['admin']::text[], false),
  ('cassie_tier_reverted', 'Cassie: Auto-Send Paused for a Tier',
   'Partner replies to Cassie''s auto-sent answers showed confusion above the configured rate for one question type + match tier, so that tier reverted to draft mode automatically.',
   'operations', array['admin']::text[], false)
on conflict (key) do nothing;
