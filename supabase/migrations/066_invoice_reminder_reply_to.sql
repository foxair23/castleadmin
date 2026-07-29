-- Configurable reply-to for invoice reminder emails.
--
-- Emails send from a no-reply address (noreply@updates.castlegaragedoors.com),
-- but the copy invites customers to reply — so replies currently go nowhere.
-- Add a reply-to the admin can point at a monitored inbox (billing/office).
alter table public.invoice_reminder_settings
  add column if not exists reply_to_email text;

comment on column public.invoice_reminder_settings.reply_to_email is
  'Reply-to for invoice reminder emails. When set, customer replies go here instead of the no-reply From address.';
