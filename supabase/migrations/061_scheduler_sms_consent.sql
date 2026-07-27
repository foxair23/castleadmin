-- Scheduler SMS consent — capture + audit.
--
-- The scheduler already had the two consent booleans on scheduler_leads
-- (customer_sms_appointment_consent, customer_sms_marketing_consent) but the UI
-- never showed a checkbox and the APIs never wrote them. We now render one
-- combined, unchecked opt-in on the phone step and persist it on BOTH the
-- partial lead and the completed booking.
--
-- Add an audit trail (when consent was given, and which disclosure copy the
-- customer saw) — proof-of-consent is what a TCPA opt-in is for.
alter table public.scheduler_leads
  add column if not exists customer_sms_consent_at   timestamptz,
  add column if not exists sms_consent_copy_version  text;

comment on column public.scheduler_leads.customer_sms_consent_at is
  'When the customer checked the SMS opt-in box (null = never consented). TCPA proof-of-consent timestamp.';
comment on column public.scheduler_leads.sms_consent_copy_version is
  'The disclosure copy the customer saw when they consented, stored verbatim for the audit trail.';

-- Refresh the disclosure copy to the approved (Dialpad-compliant) wording. This
-- is the fine print shown under the "Yes, keep me posted by text!" label; the
-- Privacy Policy link is rendered separately from legal_url. Editable later in
-- Scheduler → Settings.
update public.scheduler_settings
   set value = to_jsonb('We''ll send appointment reminders, updates, and the occasional offer from Castle Garage Inc. Reply STOP to opt out or HELP for help anytime. Message frequency varies; msg & data rates may apply.'::text)
 where key = 'tcpa_copy';

-- Where the Privacy Policy / legal links point. Editable in Settings.
insert into public.scheduler_settings (key, value)
values ('legal_url', to_jsonb('https://castlegaragedoors.com/legal'::text))
on conflict (key) do nothing;
