-- Post-Job CSAT SMS Survey (Phase 1 — core loop).
--
-- After an eligible job is completed, the customer is texted a 1–5 satisfaction
-- survey. A 5 is thanked and sent the Google review link (drives 5-star reviews);
-- a 4 is asked what would've made it a 5; a 1–3 opens a follow-up and alerts the
-- admins. Modeled on the Invoice Reminder subsystem (063): a single settings row
-- with a master on/off switch + fresh-start anchor, a per-job send guard, and the
-- shared SMS opt-out list (invoice_reminder_optouts) — nothing here re-implements
-- messaging, opt-out, or completion detection.
--
-- Master switch defaults OFF. "Fresh start": when first enabled, activated_at is
-- stamped, and the engine only surveys jobs whose work_completed_at is on/after
-- activated_at — so flipping it on never blasts the backlog of past jobs.

-- ── Settings (single row) ───────────────────────────────────────────────────
create table if not exists public.csat_settings (
  id                        int primary key default 1 check (id = 1),
  enabled                   boolean not null default false,
  activated_at              timestamptz,                    -- set when toggled on (fresh-start anchor)
  send_delay_minutes        int not null default 15,        -- min wait after completion is detected
  send_start_hour_pt        int not null default 8,         -- texting window open (PT)
  send_end_hour_pt          int not null default 19,        -- texting window close (PT, exclusive)
  alert_delay_minutes       int not null default 5,         -- wait before the low-score alert so the customer's reply detail can be included

  excluded_job_categories   text[] not null default '{}',   -- SF categories to skip (e.g. warranty)
  excluded_sources          text[] not null default '{}',   -- SF Job Sources to skip
  google_review_url         text not null default 'https://g.page/r/CaHFdfDPyEDjEBE/review',
  survey_sms                text not null default
    'Castle Garage Doors: Thank you for your business! How satisfied were you with today''s service?'||chr(10)||chr(10)||
    'Reply with a number from 1 to 5, where 5 means Very Satisfied and 1 means Very Dissatisfied.'||chr(10)||chr(10)||
    'Reply STOP to opt out.',
  thanks_5_sms              text not null default
    'We''re glad you had a great experience! Would you be willing to share your experience in a Google review? Click here: {{review_url}}'||chr(10)||chr(10)||
    'Your feedback means a lot to our family-owned business. We appreciate you!',
  ask_4_sms                 text not null default
    'Thank you for the feedback. We''re always looking for ways to serve you better. What could we have done to make your experience a 5?',
  ack_low_sms               text not null default
    'Thank you for letting us know. We''re sorry your experience did not meet expectations.'||chr(10)||chr(10)||
    'Could you share a little more about what happened? A member of our team will also reach out so we can better understand the issue and help.',
  clarify_sms               text not null default
    'Thanks! Please reply with one number from 1 to 5, where 5 means Very Satisfied and 1 means Very Dissatisfied.',
  alert_extra_recipient_emails text[] not null default '{}', -- non-app-user emails to also alert on low scores
  template_version          int not null default 1,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users(id)
);

insert into public.csat_settings (id) values (1) on conflict (id) do nothing;

-- ── Surveys (one per job) ───────────────────────────────────────────────────
create table if not exists public.csat_surveys (
  id                   uuid primary key default gen_random_uuid(),
  sf_job_id            text not null unique,               -- send-once guard
  sf_customer_id       text,
  customer_name        text,
  phone_e164           text,
  -- Attribution snapshot (frozen at send so reporting stays stable).
  assigned_tech_ids    text[] not null default '{}',       -- SF tech ids on the job
  assigned_tech_names  text[] not null default '{}',       -- "First Last" snapshot
  primary_tech_name    text,                               -- display/grouping key
  primary_tech_user_id uuid references public.profiles(id),-- admin-correctable app user link
  job_category         text,
  job_source           text,
  city                 text,
  postal_code          text,
  work_completed_at    timestamptz,
  status               text not null default 'scheduled'
    check (status in ('scheduled','sent','responded','failed','excluded','expired')),
  excluded_reason      text,
  scheduled_send_at    timestamptz,
  sent_at              timestamptz,
  provider_message_id  text,
  send_error           text,
  clarify_sent_at      timestamptz,                        -- clarification sent at most once
  feedback_pending     boolean not null default false,     -- true after a 4, awaiting the free-text reason
  review_requested_at  timestamptz,
  review_msg_status    text,
  is_test              boolean not null default false,     -- test rows excluded from metrics
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_csat_surveys_status  on public.csat_surveys(status);
create index if not exists idx_csat_surveys_phone   on public.csat_surveys(phone_e164);
create index if not exists idx_csat_surveys_sent_at on public.csat_surveys(sent_at desc);

-- ── Responses (one row per inbound; latest valid rating is current) ─────────
create table if not exists public.csat_responses (
  id                  uuid primary key default gen_random_uuid(),
  survey_id           uuid not null references public.csat_surveys(id) on delete cascade,
  sf_job_id           text not null,
  rating              smallint check (rating between 1 and 5),  -- null when unparsed
  classification      text not null check (classification in ('high','satisfied','low','invalid')),
  raw_message         text,
  feedback_text       text,
  is_current          boolean not null default false,          -- the survey's current valid rating
  provider_message_id text,
  dedup_key           text not null unique,                    -- provider id or content hash (webhook idempotency)
  received_at         timestamptz not null default now()
);
create index if not exists idx_csat_responses_survey  on public.csat_responses(survey_id);
create index if not exists idx_csat_responses_current on public.csat_responses(survey_id) where is_current;

-- ── Follow-ups (lightweight recovery seed; full workflow is a later phase) ──
create table if not exists public.csat_follow_ups (
  id                uuid primary key default gen_random_uuid(),
  survey_id         uuid not null references public.csat_surveys(id) on delete cascade,
  sf_job_id         text not null,
  rating            smallint,
  status            text not null default 'open' check (status in ('open','acknowledged','resolved')),
  acknowledged_by   uuid references public.profiles(id),
  acknowledged_at   timestamptz,
  resolved_by       uuid references public.profiles(id),
  resolved_at       timestamptz,
  notes             text,
  -- Deferred alert: the internal email is dispatched once alert_after passes, so
  -- any detail the customer texts back in that window is included. alerted_at is
  -- stamped when the email has been enqueued (null = still pending).
  alert_after       timestamptz,
  alerted_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (survey_id)
);
create index if not exists idx_csat_follow_ups_status on public.csat_follow_ups(status);
create index if not exists idx_csat_follow_ups_pending on public.csat_follow_ups(alert_after) where alerted_at is null;

-- ── Low-score alert notification type (email to subscribed admins) ──────────
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'low_csat_alert',
  'Low CSAT Alert',
  'Alert when a customer rates a completed job 1–3 on the post-job survey.',
  'operations',
  array['admin'],
  false
)
on conflict (key) do nothing;

-- Backfill: the auto-populate trigger only fires for NEW profiles, so subscribe
-- existing admins to the new type explicitly.
insert into public.user_notification_preferences (user_id, notification_type_id, is_enabled)
select p.id, nt.id, true
from public.profiles p
cross join public.notification_types nt
where nt.key = 'low_csat_alert' and p.role = 'admin'
on conflict (user_id, notification_type_id) do nothing;

-- ── RLS: admin-only (matches invoice_reminders) ─────────────────────────────
alter table public.csat_settings    enable row level security;
alter table public.csat_surveys     enable row level security;
alter table public.csat_responses   enable row level security;
alter table public.csat_follow_ups  enable row level security;

drop policy if exists "admin_all_csat_settings" on public.csat_settings;
create policy "admin_all_csat_settings" on public.csat_settings for all using (public.is_admin());
drop policy if exists "admin_all_csat_surveys" on public.csat_surveys;
create policy "admin_all_csat_surveys" on public.csat_surveys for all using (public.is_admin());
drop policy if exists "admin_all_csat_responses" on public.csat_responses;
create policy "admin_all_csat_responses" on public.csat_responses for all using (public.is_admin());
drop policy if exists "admin_all_csat_follow_ups" on public.csat_follow_ups;
create policy "admin_all_csat_follow_ups" on public.csat_follow_ups for all using (public.is_admin());
