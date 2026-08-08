-- "Portal session logged out" notification type.
--
-- The browser extension automates Service Fusion (remittance posting, notes) and
-- crawls the Genie/Home Depot portal — all riding the user's logged-in browser
-- session on the always-on office PC. When a site logs the session out, that
-- automation stalls until someone signs back in. This notification lets an admin
-- pick (in the Notifications tab) who gets an email when that happens.
-- default_for_roles empty → nobody is auto-subscribed; recipients chosen explicitly.

insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'portal_session_logged_out',
  'Portal Session Logged Out',
  'Emails chosen recipients when the browser extension finds a site (Service Fusion or the Genie/Home Depot portal) logged out, so someone can sign back in on the office PC and resume automation.',
  'operations',
  array[]::text[],
  false
)
on conflict (key) do nothing;
