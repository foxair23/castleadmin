-- Per-reminder message copy.
--
-- Move email subject/body + SMS text into each cadence stage, so the language
-- can escalate stage to stage. Drops the old single global templates.
-- Each cadence stage is now:
--   { "day": N, "channels": ["email"|"sms"...],
--     "email_subject": "...", "email_body": "...", "sms_body": "..." }

alter table public.invoice_reminder_settings
  drop column if exists email_subject,
  drop column if exists email_body,
  drop column if exists sms_body;

-- Escalating default series (editable in admin). Dollar-quoted so apostrophes
-- in the copy don't need escaping.
do $$
declare
  default_cadence jsonb := $json$[
    {
      "day": 7,
      "channels": ["email"],
      "email_subject": "A quick reminder about invoice {{invoice_number}}",
      "email_body": "Hi {{customer}},\n\nJust a friendly reminder that invoice {{invoice_number}} still shows a balance of {{amount_due}}. Whenever you get a chance, you can take care of it online using the button below.\n\nThank you for choosing Castle Garage Inc.",
      "sms_body": "Castle Garage Inc: invoice {{invoice_number}} has a balance of {{amount_due}}. Pay here: {{pay_url}} Reply STOP to opt out."
    },
    {
      "day": 14,
      "channels": ["email"],
      "email_subject": "Invoice {{invoice_number}} is past due",
      "email_body": "Hi {{customer}},\n\nOur records show invoice {{invoice_number}} is now past due with a balance of {{amount_due}}. Please take a moment to pay it online using the button below, or give us a call if there is anything we can help sort out.\n\nThank you,\nCastle Garage Inc",
      "sms_body": "Castle Garage Inc: invoice {{invoice_number}} is past due, balance {{amount_due}}. Pay here: {{pay_url}} Reply STOP to opt out."
    },
    {
      "day": 30,
      "channels": ["email", "sms"],
      "email_subject": "Final notice — invoice {{invoice_number}} balance due",
      "email_body": "Hi {{customer}},\n\nInvoice {{invoice_number}} remains unpaid with a balance of {{amount_due}} and is now significantly past due. Please pay it online using the button below as soon as possible. If you have already paid or need to discuss this, please call us right away at (800) 576-1397.\n\nCastle Garage Inc",
      "sms_body": "Castle Garage Inc: FINAL NOTICE — invoice {{invoice_number}} balance {{amount_due}} is past due. Pay now: {{pay_url}} Reply STOP to opt out."
    }
  ]$json$;
begin
  alter table public.invoice_reminder_settings alter column cadence set default default_cadence;
  update public.invoice_reminder_settings set cadence = default_cadence where id = 1;
end $$;
