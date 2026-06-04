# Castle Garage Doors & Gates — Piecework Payroll App
## PRD — Email Notifications

---

## 1. Purpose

Add transactional email notifications to Castle Admin so users find out about things they need to act on without having to log in and check. This PRD ships two things: **(a)** the reusable email infrastructure (sender, templates, scheduler, dedup, admin-controlled per-user preferences), and **(b)** five specific notifications built on top of it.

The infrastructure is the bigger value here — every future notification becomes a small addition rather than its own project.

This builds on all prior PRDs (v1 payroll, v2 SF sync, Phase 1 Analytics, SF Mirror/Mailchimp/Alerts, Sales Dashboard). **Nothing in those is changed or removed.** This PRD adds a notifications layer, two admin screens, a "Notifications" view in the user gear menu, and one new operational alert.

---

## 2. The Five Notifications

| # | Notification | Trigger type | Audience |
|---|---|---|---|
| 1 | **Submit Piecework Reminder** | Scheduled | Technicians (default) |
| 2 | **New Sales Lead Assigned to You** | Event-driven (when admin assigns) | Sales reps (default) |
| 3 | **Data Sync Has Not Run** | Scheduled conditional check | Admin (default) |
| 4 | **Scheduler Lead Synced to Service Fusion** | Event-driven (scheduler emits success) | Admin (default) |
| 5 | **Scheduler Lead Stuck — Needs Manual SF Push** | Event-driven (scheduler emits failure or partial) | Admin (default) |

"Default" means the default recipient when the role is created. **Every notification is fully configurable per user by the admin** (§5).

This PRD also adds a **7th operational alert** to the existing Action Items framework: **"Scheduler Leads Awaiting Manual SF Push"** — see §6.6.

---

## 3. Email Infrastructure

### 3.1 Provider — Resend
- All transactional email is sent via the Resend API.
- API key stored as a Vercel environment variable (`RESEND_API_KEY`).
- Sender address: **`noreply@castlegaragedoors.com`** with display name "Castle Admin."
- A reply-to address is configurable (default: empty, since these are no-reply notifications).
- DNS records (SPF, DKIM, DMARC) must be set up for the `castlegaragedoors.com` domain to keep deliverability healthy. Resend's dashboard provides the exact DNS strings to add; this is a one-time setup task during build (see §10).

### 3.2 Email templates
- Each notification has a server-side template: subject line, plain-text body, HTML body.
- Templates support simple variable substitution (e.g., `{{customer_name}}`, `{{lead_url}}`).
- All emails include a footer: "You're receiving this because notifications are turned on for your Castle Admin account. To change your preferences, contact your admin."
- Templates live in code, version-controlled. No template-editing UI (out of scope; admins who want copy changes ask Claude Code).

### 3.3 The notification queue and sender service
- Every notification event creates a row in `notification_log` (queued).
- A small worker (a Vercel scheduled function running every 1–2 minutes) picks up queued rows, sends them via Resend, and marks them sent / failed.
- This decouples "decided to notify" from "actually sent" — so the action that triggered the notification doesn't wait on Resend, and a Resend outage doesn't break the triggering action.

### 3.4 Deduplication
- A 24-hour dedup window per **(user × notification_type × related_entity_id)**.
- Example: "lead 12345 is stuck" can only email the same admin once in a 24-hour period.
- The dedup check happens before queuing — duplicate events log as "deduped" for visibility but never send.

### 3.5 No quiet hours
Per owner decision: emails send at any time of day. The notifications we're shipping are either user-action-driven (the user just made something happen) or time-of-day-bounded by their own scheduled trigger (e.g., the piecework reminder doesn't fire at 3am — it fires at the scheduled time), so this is fine.

### 3.6 Failure handling
- On Resend API error: retry up to 3 times with exponential backoff.
- Persistent failures are logged in `notification_log` with the error and never silently dropped.
- A small admin diagnostic — "Recent notification failures" — surfaces these (§5.3).

---

## 4. Data Model

### 4.1 New tables

**`notification_types`** — the catalog of available notifications:
- `id`, `key` (stable identifier, e.g. `piecework_reminder`), `display_name`, `description`, `category` (e.g. `scheduler`, `sales`, `payroll`, `system`), `default_for_role` (which role gets this by default), `is_active`

Seeded with the five notification types in §2 (extensible — new types are added by inserting a row and writing the template + trigger).

**`user_notification_preferences`** — one row per (user × notification_type) the user is subscribed to:
- `id`, `user_id`, `notification_type_id`, `is_enabled`, `updated_at`, `updated_by_user_id`

Default state when a user is created: all `default_for_role` notifications for that user's role are enabled. Admin can modify any of these afterward (§5).

**`notification_log`** — every queued/sent/failed notification:
- `id`, `user_id`, `notification_type_id`, `related_entity_type` (string, e.g. `lead`, `job`, `sync_run`), `related_entity_id` (nullable), `subject`, `body_html`, `body_text`, `status` (`queued`/`sent`/`failed`/`deduped`), `attempts`, `last_attempt_at`, `sent_at`, `error_message`, `created_at`

This is the audit trail and the source of dedup checks.

### 4.2 Scheduler integration points

The scheduler tool (already existing) needs to emit two events that the notification system listens for. The events are:
- `scheduler.lead.synced_to_sf` — payload: `lead_id`, `customer_name`, `job_summary`, `sf_job_id`.
- `scheduler.lead.stuck` — payload: `lead_id`, `customer_name`, `failure_reason` (e.g. `partial_data`, `sf_api_error`, `unmapped_field`), `details`.

This PRD does **not** modify the scheduler itself beyond adding these emit calls. Claude Code will need to wire the emit calls into the existing scheduler code at the two points where a lead either succeeds or fails to push to SF.

---

## 5. Admin: Notification Settings Screen (new)

A new admin screen, accessible from the gear menu → "Notification Settings."

### 5.1 The matrix view (primary UI)

A table with **users as rows** and **notification types as columns**. Each cell is a checkbox.

|  | Submit Piecework Reminder | New Sales Lead Assigned | Sync Has Not Run | Scheduler Lead Synced | Scheduler Lead Stuck |
|---|---|---|---|---|---|
| **John (admin)** | ☐ | ☐ | ☑ | ☑ | ☑ |
| **Mike (tech)** | ☑ | ☐ | ☐ | ☐ | ☐ |
| **Sarah (sales)** | ☐ | ☑ | ☐ | ☐ | ☐ |
| ... | | | | | |

- Click any cell to toggle that user's subscription to that notification type.
- Saves immediately (no separate save button).
- Hover/tap a column header to see the notification's description and trigger.
- A small text indicator under each user shows their role for context.

### 5.2 Filters

- Filter by role (just admins, just techs, just sales).
- Filter by notification category (payroll, sales, scheduler, system).
- "Show only active users" toggle (deactivated users are hidden by default).

### 5.3 Recent notification activity panel

Below the matrix, a collapsible panel: "Recent Notifications (last 7 days)."
- Table of recently queued/sent notifications: timestamp, recipient, type, status, related entity.
- Click a failed row to see the error message.
- Helps diagnose "I didn't get the email" complaints quickly.

---

## 6. The Five Notifications — Detail

### 6.1 Submit Piecework Reminder

**Trigger:** Vercel Cron, weekly.
- **First reminder:** Wednesday 9:00 AM Pacific (workweek ends Sunday, submission deadline Wednesday 11:59 PM per v1 PRD).
- **Final reminder:** Wednesday 6:00 PM Pacific.
- Each reminder runs the check: for every technician with notifications enabled, is there a `week_submissions` row for the just-closed workweek? If no, email them.

**Email:**
- Subject: "Reminder: submit your piecework for the week of [Mon date] – [Sun date]"
- Body: brief, friendly, links to the My Week screen.

### 6.2 New Sales Lead Assigned to You

**Trigger:** Event — fires the moment an admin saves a lead-assignment in the Sales Dashboard (single or bulk).

**Email:**
- Subject: "New lead assigned: [Customer Name] (campaign: [tag])"
- Body: customer name, the campaign tag, engagement summary (opened N times, clicked / not clicked), and a deep link to the lead detail screen.
- **Bulk-assign batching:** if an admin bulk-assigns 10 leads to one rep in a single action, the rep gets **one combined email** listing all 10, not 10 separate emails. The dedup window does not help here (different lead IDs); this is explicit batching at the trigger point: if multiple `lead.assigned` events fire for the same rep within a 60-second window, they're collapsed into one email.

### 6.3 Data Sync Has Not Run

**Trigger:** Vercel Cron, daily at 10:00 AM Pacific.
- Checks `sf_sync_runs` for a successful run in the last **30 hours** — matched intentionally to the existing 30-hour error-flag threshold in Castle Admin, so the email fires at the same moment the error flag appears on screen (single source of truth).
- If no successful run found, sends the notification.

**Email:**
- Subject: "⚠️ Service Fusion sync did not run in the last 30 hours"
- Body: when the last successful sync was, the last failure (if any) with error detail, link to the Service Fusion Sync admin screen.

### 6.4 Scheduler Lead Synced to Service Fusion

**Trigger:** Event — `scheduler.lead.synced_to_sf` (emitted by the scheduler when a lead pushes successfully).

**Email:**
- Subject: "New scheduler lead synced to SF: [Customer Name]"
- Body: customer name, summary of the job request (service type, requested date/time, address), SF job ID, and a link to view in SF.
- Informational — no action required.

### 6.5 Scheduler Lead Stuck — Needs Manual SF Push

**Trigger:** Event — `scheduler.lead.stuck` (emitted by the scheduler when a lead fails to push or is incomplete).

**Email:**
- Subject: "🚧 Scheduler lead stuck: [Customer Name] — needs manual SF push"
- Body: customer name, why it failed (e.g. "missing address," "SF API returned 500," "service type didn't map to an SF category"), and a deep link to the stuck lead inside Castle Admin so the recipient can fix and push it.
- **Action required** — paired with the operational alert in §6.6.

### 6.6 New operational alert: "Scheduler Leads Awaiting Manual SF Push"

Added to the existing Action Items framework as the **7th alert**, alongside the six already shipped.
- Lists every scheduler lead in a `stuck` state in Castle Admin.
- Columns: customer name, scheduler submission date, failure reason, days stuck.
- Sortable by date stuck and by failure reason. Persistent (stays visible until the lead is resolved).
- The email (§6.5) prompts; the alert holds it as a to-do until done. Both are needed.

---

## 7. User: Notifications View (gear menu)

A read-only "Notifications" tab visible to every logged-in user under the gear menu.

- Shows the list of notification types and a checkmark next to each one the user is subscribed to.
- Each entry shows: name, description, brief trigger explanation.
- A note at the bottom: "To change your notification settings, contact your admin."
- No edit controls — admin-managed only, per owner decision.

---

## 8. Out of Scope

- In-app notifications (no notification bell, no notification center UI). Per owner decision: email only.
- User-editable preferences (admin-only management).
- SMS / push notifications.
- Quiet hours / do-not-disturb.
- Per-user notification timing preferences (everyone on the same schedule).
- Template editing UI (templates are code-managed).
- Two-way email (replies are not processed; sender is `noreply@`).
- Notifications for the other six operational alerts. The existing alerts framework remains screen-only as designed; only the new "Scheduler Leads Stuck" alert is paired with an email because it's action-urgent and event-triggered. If you later want emails for other alerts, that's a small follow-on PRD.

---

## 9. Acceptance Criteria

1. `RESEND_API_KEY` is configured; DNS records for `castlegaragedoors.com` are set up; a test email from `noreply@castlegaragedoors.com` arrives without going to spam in a Gmail and Outlook inbox.
2. The five notification types are seeded in `notification_types` with sensible default-for-role assignments.
3. When a new user is created, their `user_notification_preferences` are auto-populated with their role's defaults.
4. The admin Notification Settings matrix correctly displays all users × notification types, and toggling a cell immediately updates the preference.
5. The submit-piecework reminder fires Wednesday 9 AM and 6 PM Pacific to techs who have notifications enabled and haven't submitted their week.
6. Assigning a lead in the Sales Dashboard triggers the "new lead assigned" email to the rep (if enabled).
7. Bulk-assigning 5+ leads to the same rep results in **one** combined email listing all of them, not 5 separate emails.
8. The daily sync-not-run check correctly fires only when the last successful SF sync is older than 30 hours, matching the existing in-app error-flag threshold.
9. Scheduler events `scheduler.lead.synced_to_sf` and `scheduler.lead.stuck` produce the corresponding emails.
10. A stuck scheduler lead appears as the 7th alert on the Action Items screen.
11. The 24-hour dedup window prevents the same (user × type × entity) from emailing twice.
12. The Notification Activity panel on the admin screen shows recent sent/queued/failed/deduped notifications correctly.
13. The user gear menu shows a read-only "Notifications" tab listing what the user is subscribed to.
14. A Resend failure retries up to 3 times and ultimately logs `failed` with the error; it does not block the triggering action.
15. No v1, v2, Phase 1, Mirror/Mailchimp/Alerts, or Sales Dashboard functionality has regressed.

---

## 10. Setup Tasks (one-time, owner involvement required)

1. **Create a Resend account** (free tier is fine to start) and generate an API key. Save it in Vercel as `RESEND_API_KEY`.
2. **Add and verify the `castlegaragedoors.com` domain in Resend.** Resend will provide a short list of DNS records (SPF, DKIM, DMARC). These go into your DNS provider's dashboard — about 10 minutes of work. Required for deliverability.
3. **Confirm `noreply@castlegaragedoors.com` is the sender you want** (or pick a different one) — no inbox needs to exist at this address, it's send-only.

---

## 11. Open Questions

*All resolved.*

**Resolved decisions:**
- **Default-for-role assignments:** techs get the piecework reminder; sales reps get the lead-assigned email; admin gets the three system/scheduler ones. Admin can override per user after setup via the matrix (§5.1).
- **Reply-to address:** left empty (true no-reply). Replies to these emails won't be received or processed.
- **Bulk-assign batching window:** 60 seconds. Multiple lead-assignments to the same rep within 60s of each other collapse into a single combined email rather than firing one per lead.
- **Sync-not-run grace window:** 30 hours, aligned to Castle Admin's existing 30-hour error-flag threshold so the email and the in-app error indicator fire from the same condition.

## 12. Email Content Review (build-phase step)

Before this feature goes live, Claude Code will produce draft text for all five email templates (subject lines, plain-text bodies, HTML bodies, including variable substitution markers like `{{customer_name}}`). The owner reviews and approves each draft during the build — iterations happen in chat with Claude Code, not in a separate UI.

After launch, wording changes are made by asking Claude Code (e.g., "change the piecework reminder subject to X"); they're small code edits. Per §8, there is no in-app template editor in this build. If template-editing ever becomes a frequent need, it can be added as a small follow-on PRD.

---
*End of PRD.*
