-- Generalize the portal-session alert into a broad automation/crawler alert:
-- one notification type for ANY error the browser extension hits — a site logged
-- out, a crawl that times out, a remittance post that fails — across Service
-- Fusion, the Genie/Home Depot portal, and future integrations. Recipients are
-- chosen in the Notifications tab (nobody auto-subscribed).

insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'automation_alert',
  'Automation & Crawler Alerts',
  'Emails chosen recipients when the browser extension hits a problem — a site logged out, a crawl failed/timed out, or a post failed — for Service Fusion, the Genie/Home Depot portal, and future integrations.',
  'operations',
  array[]::text[],
  false
)
on conflict (key) do nothing;

-- Retire the narrower session-only type (nobody was subscribed to it).
update public.notification_types set is_active = false where key = 'portal_session_logged_out';
