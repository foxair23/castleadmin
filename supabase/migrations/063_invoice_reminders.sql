-- Invoice Reminder Automation.
--
-- Our own unpaid-invoice reminders, filtered by Job Source so 3rd-party-paid
-- jobs (Clopay/Genie/…) are excluded — the thing SF's built-in reminders can't
-- do. Email-first with SMS (Dialpad) per a configurable cadence.
--
-- Master switch defaults OFF. "Fresh start": when first enabled, activated_at is
-- stamped, and the engine only fires a stage whose due date falls on/after
-- activated_at — so flipping it on never blasts the existing backlog.

-- ── Settings (single row) ───────────────────────────────────────────────────
create table if not exists public.invoice_reminder_settings (
  id               int primary key default 1 check (id = 1),
  enabled          boolean not null default false,
  activated_at     timestamptz,                      -- set when toggled on (fresh-start anchor)
  send_hour_pt     int not null default 9,           -- daily send hour, PT
  excluded_sources text[] not null default '{}',     -- SF Job Sources to skip (3rd-party paid)
  -- Ordered cadence: [{ "day": 7, "channels": ["email"] }, …]. The series just
  -- stops after the last row.
  cadence          jsonb not null default
    '[{"day":7,"channels":["email"]},{"day":14,"channels":["email"]},{"day":30,"channels":["email","sms"]}]'::jsonb,
  email_subject    text not null default 'Invoice {{invoice_number}} — balance due',
  email_body       text not null default
    'Hi {{customer}},'||chr(10)||chr(10)||
    'Our records show an outstanding balance of {{amount_due}} on invoice {{invoice_number}} from Castle Garage Inc.'||chr(10)||chr(10)||
    'You can view and pay it securely here: {{pay_url}}'||chr(10)||chr(10)||
    'If you''ve already paid, please disregard this message. Questions? Just reply or give us a call.'||chr(10)||chr(10)||
    'Thank you,'||chr(10)||'Castle Garage Inc',
  sms_body         text not null default
    'Castle Garage Inc: invoice {{invoice_number}} has a balance of {{amount_due}}. Pay here: {{pay_url}} Reply STOP to opt out.',
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

insert into public.invoice_reminder_settings (id) values (1) on conflict (id) do nothing;

-- ── Sent-reminder log (one row per stage+channel actually sent) ──────────────
create table if not exists public.invoice_reminders (
  id                  uuid primary key default gen_random_uuid(),
  sf_invoice_id       text not null,
  sf_job_id           text,
  stage_index         int not null,        -- 0-based index into the cadence array at send time
  stage_day           int not null,        -- the day offset of that stage
  channel             text not null check (channel in ('email','sms')),
  recipient           text not null,
  status              text not null default 'sent' check (status in ('sent','failed')),
  provider_message_id text,
  error               text,
  amount_due          numeric(12,2),
  pay_url             text,
  sent_at             timestamptz not null default now(),
  -- A given stage's channel is sent at most once per invoice.
  unique (sf_invoice_id, stage_index, channel)
);
create index if not exists idx_invoice_reminders_invoice on public.invoice_reminders(sf_invoice_id);
create index if not exists idx_invoice_reminders_sent_at on public.invoice_reminders(sent_at desc);

-- ── Opt-outs (STOP replies + manual do-not-contact), per recipient ──────────
create table if not exists public.invoice_reminder_optouts (
  id         uuid primary key default gen_random_uuid(),
  channel    text not null check (channel in ('email','sms')),
  value      text not null,                    -- normalized: E.164 phone / lowercased email
  reason     text not null default 'manual' check (reason in ('stop','manual')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (channel, value)
);

-- ── Per-invoice "do not remind" ─────────────────────────────────────────────
create table if not exists public.invoice_reminder_skips (
  sf_invoice_id text primary key,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

-- ── RLS: admin-only ─────────────────────────────────────────────────────────
alter table public.invoice_reminder_settings enable row level security;
alter table public.invoice_reminders          enable row level security;
alter table public.invoice_reminder_optouts   enable row level security;
alter table public.invoice_reminder_skips      enable row level security;

drop policy if exists "admin_all_invoice_reminder_settings" on public.invoice_reminder_settings;
create policy "admin_all_invoice_reminder_settings" on public.invoice_reminder_settings for all using (public.is_admin());
drop policy if exists "admin_all_invoice_reminders" on public.invoice_reminders;
create policy "admin_all_invoice_reminders" on public.invoice_reminders for all using (public.is_admin());
drop policy if exists "admin_all_invoice_reminder_optouts" on public.invoice_reminder_optouts;
create policy "admin_all_invoice_reminder_optouts" on public.invoice_reminder_optouts for all using (public.is_admin());
drop policy if exists "admin_all_invoice_reminder_skips" on public.invoice_reminder_skips;
create policy "admin_all_invoice_reminder_skips" on public.invoice_reminder_skips for all using (public.is_admin());
