-- The per-event extension emails (automation_alert: "crawl timed out", "N lines failed",
-- "is logged out") are replaced by Automation Health (migration 129): a 7am summary and
-- alerts only on a condition turning red or recovering. Subscribers were copied across in
-- 129; here the old type stops sending. The only extension-originated email left — an
-- auto-login that failed twice — now goes out under automation_health too.
update public.notification_types set is_active = false where key = 'automation_alert';
