-- Excluded bill-to email domains for invoice reminders.
--
-- Some 3rd-party billers (e.g. Greystar) have their jobs logged under a generic
-- Job Source like "Repeat Customer", so source-based exclusion can't catch them
-- — but they all bill to a common email domain (@greystar.com). Let admins
-- exclude by domain; any invoice billing to a listed domain is skipped entirely.
alter table public.invoice_reminder_settings
  add column if not exists excluded_email_domains text[] not null default '{}';
