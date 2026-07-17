-- Weekly Accounts Receivable Aging Report (Monday 7 AM PT). Sent as three
-- separate emails (Clopay, Genie, Remainder) to the castle-admin users an admin
-- opts in from the Notifications tab. default_for_roles is empty so nobody is
-- auto-subscribed — recipients are chosen explicitly per the requirement.

insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'weekly_ar_aging',
  'Weekly AR Aging Report',
  'Monday 7 AM PT Accounts Receivable aging report from the Unpaid Jobs list — three emails: Clopay, Genie, and Remainder.',
  'operations',
  array[]::text[],
  false
)
on conflict (key) do nothing;
