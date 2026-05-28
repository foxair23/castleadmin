# Castle Garage Doors & Gates — Piecework Payroll App
## PRD — Sales Dashboard: Mailchimp Engagement → Sales Workflow → Service Fusion Handoff

---

## 1. Purpose

Close the loop on the Mailchimp marketing integration. When Castle pushes a tagged batch of contacts into Mailchimp and a campaign goes out, this feature pulls back **who opened the email** (and optionally clicked), turns those engaged contacts into **sales leads** inside Castle Admin, assigns them to **sales reps**, and provides a structured workflow for the rep to **log calls**, **advance the lead through a pipeline**, and ultimately **hand off a closed-won deal to Service Fusion** for the actual job to be booked.

This builds on the prior PRDs (v1 payroll, v2 SF sync, Phase 1 Analytics, the SF Mirror + Mailchimp + Alerts PRD). **Nothing in those is changed or removed.** This PRD adds:
- A new **Sales tab** in Castle Admin.
- A new **`sales`** user role alongside `admin` and `technician`.
- Mailchimp campaign reporting (opens and clicks) pulled into the mirror.
- A sales pipeline data model (leads, calls, statuses, dispositions).
- A "ready for SF handoff" screen for closed-won deals.

The Service Fusion handoff is **manual** — the rep reads the info off the handoff screen and creates the job in SF themselves. No new write-integration to SF.

---

## 2. Roles & Permissions (extension of existing model)

| Role | Sees |
|---|---|
| **admin** | Everything — all existing v1/v2/Phase 1/Mirror screens, plus the Sales tab in full (master lead list, all reps, assignment controls, all dispositions and statuses, all reports). |
| **technician** | Unchanged. No Sales tab. |
| **sales** (new) | **Only** the Sales tab. Sees only leads that have been assigned to them. Can see full customer detail from the mirror (history, equipment, account balance, past jobs, payment history). Can see other reps' notes/calls on shared leads (see §5.1). Cannot manage tracked campaigns, cannot reassign leads, cannot change pipeline configuration. |

Sales-user accounts are created and managed by an admin on the existing Manage Users screen — extended with the new role option. Sales users authenticate the same way as everyone else.

---

## 3. Data Sources & Sync

### 3.1 What we pull from Mailchimp

The Mailchimp Marketing API exposes per-campaign open and click data. The endpoints we'll use:

- **List campaigns** (to discover campaigns sent from the audience).
- **Campaign open details** — for a given campaign, list every member who opened, with timestamps and open counts.
- **Campaign click details** — same shape, for clicks on tracked links.
- **Campaign report** — summary stats per campaign (total opens, total clicks, etc.).

### 3.2 What gets tracked

**A "tracked campaign" is any Mailchimp campaign that was sent from a tag created by a Castle Admin push.** Since every batch pushed from Castle Admin requires a tag (per the prior PRD), and the campaign in Mailchimp can be associated to recipients via that tag, we auto-detect which campaigns are "ours" and watch them by default. Admin can also manually flag any other campaign to track.

A tracked campaign carries forward the tag it was sent to, so the lead inherits that tag when imported.

### 3.3 Sync model — on-demand only, owner/rep triggered

Per owner decision: **no automatic background polling of Mailchimp.** Engagement data is pulled when someone presses a **"Sync from Mailchimp"** button on the Sales dashboard. The button:
- Pulls open and click data for every tracked campaign (with a per-call cap and pagination — Mailchimp returns up to 1000 per page).
- Upserts engagement records into the sync tables (§4).
- Creates new lead records for newly engaged customers (anyone who opened a tracked campaign for the first time).
- Updates existing lead records with new engagement counts and last-engagement timestamps.
- Shows a result toast: "Synced N campaigns, X new openers, Y new clickers."

Both admins and assigned sales reps can press the sync button. There is a soft rate-limit on it (no more than once every 5 minutes per user) to avoid hammering Mailchimp.

### 3.4 New mirror tables

- **`mc_campaigns`** — id, mailchimp_campaign_id, mailchimp_audience_id, subject, send_time, tag_name (the Castle-pushed tag, if known), total_recipients, total_opens, total_clicks, is_tracked (bool), last_synced_at.
- **`mc_campaign_engagement`** — id, mailchimp_campaign_id, email, customer_id (FK to `sf_customers`, nullable if no match), first_opened_at, last_opened_at, open_count, first_clicked_at, last_clicked_at, click_count, last_synced_at. One row per (campaign, email).
- **`mc_sync_runs`** — id, triggered_by_user, triggered_at, campaigns_synced, new_openers, new_clickers, success, error_message.

**Joining engagement to a customer:** match by email against the `sf_customer_contacts.email`. If no match (e.g., a Mailchimp contact that's no longer in SF), the engagement record is still stored and surfaces on a small "Unmatched engagements" panel — admin can manually link or dismiss.

---

## 4. The Lead Data Model

### 4.1 Lead = (customer, campaign) pair

Per owner decision: a single customer who engages with multiple campaigns generates **multiple separate leads** — one per campaign. Same underlying customer record (in `sf_customers`), shared full history, but the *work* is structured per campaign because the script, goal, and disposition vocabulary differ (a balance-due-reminder call ≠ a spring-tune-up call).

### 4.2 Tables

**`sales_leads`** — one row per (customer × campaign) lead:
- `id`
- `customer_id` (FK to `sf_customers`)
- `mailchimp_campaign_id` (FK to `mc_campaigns`)
- `tag_name` — the campaign tag (also stored on the campaign, but denormalized here for fast filtering)
- `status` — current pipeline stage (see §4.3)
- `assigned_to_user_id` (FK to `users`, nullable while unassigned)
- `assigned_at`, `assigned_by_user_id`
- `created_at` — when the lead was first imported (the moment they first opened)
- `first_opened_at`, `last_opened_at`, `open_count`
- `first_clicked_at`, `last_clicked_at`, `click_count`
- `last_activity_at` — most recent of opens, clicks, calls, or notes (drives "stale lead" aging)
- `closed_at`, `closed_outcome` (`won` / `lost`)
- `sf_job_created` (bool, default false), `sf_job_marked_created_at` — set when the rep confirms the SF job is created (§7.4)

**`sales_calls`** — one row per logged call:
- `id`, `lead_id` (FK), `user_id` (which rep made the call), `called_at`
- `disposition` — outcome of *this* call (see §4.4)
- `duration_minutes` (optional, manually entered)
- `notes` (free text)

**`sales_notes`** — one row per free-text note added to a lead independent of a call:
- `id`, `lead_id`, `user_id`, `created_at`, `body`

**`sales_status_history`** — audit trail of pipeline-status changes:
- `id`, `lead_id`, `user_id`, `from_status`, `to_status`, `changed_at`

### 4.3 Pipeline statuses (default, admin-editable)

A lead's overall position in the funnel:

1. **New** — engaged via Mailchimp but never contacted by a rep.
2. **Contacted** — a rep has logged at least one call with any disposition.
3. **Engaged** — rep had a real conversation (reached a Connected disposition at least once).
4. **Quoted** — a quote has been provided.
5. **Closed Won** — deal won; awaiting SF job creation.
6. **Closed Lost** — deal lost.

Status advances are *suggested* automatically when a relevant call disposition is logged (e.g., logging a "Connected" disposition prompts an advance from New/Contacted → Engaged), but the rep confirms. Status can also be set manually.

### 4.4 Call dispositions (default, admin-editable)

What happened on *this specific call*:

- **Connected** — spoke with the customer.
- **Voicemail** — left a voicemail.
- **No Answer** — no answer, no voicemail.
- **Bad Number** — number is wrong/disconnected.
- **Not Interested** — customer explicitly declined.
- **Callback Requested** — customer asked to be called back later.
- **Quote Sent** — quote provided during/after this call.
- **Closed Won** — deal closed on this call.
- **Closed Lost** — deal lost on this call.

Both lists are stored in `sales_pipeline_statuses` and `sales_call_dispositions` tables, admin-editable.

---

## 5. The Sales Tab

A new top-level nav item, visible to **admin** and **sales** roles.

### 5.1 Master Lead List (admin view)

Default view for admins. Sortable, filterable table of every lead in the system. Columns:

- Customer name, city
- Campaign / tag
- Status
- Assigned to (rep name or "Unassigned")
- Engagement summary (opens, clicks, last opened)
- Days since assigned
- Days since last activity
- Last call disposition

Filters (combinable):
- Campaign / tag (multi-select)
- Status (multi-select)
- Assigned rep (including "Unassigned")
- Engagement: opened only, clicked only, both
- Date range (lead created, last activity)

Bulk actions: **assign selected leads to a rep**, mark a tag of leads as not-worth-pursuing (bulk Closed Lost with a reason).

### 5.2 Sales rep view

Default view for `sales` users. Same table layout but **filtered to leads where `assigned_to_user_id = self`**. The rep cannot see leads assigned to other reps in this view.

Default sort: New status first, then by `last_activity_at` ascending (oldest cold leads bubble up for follow-up).

Rep-side filters: campaign/tag, status, engagement (opened/clicked).

A **"Sync from Mailchimp"** button is prominent at the top so the rep can pull in fresh openers themselves between sessions.

### 5.3 Lead detail screen

Click any lead to open its detail screen. Contents, top to bottom:

- **Header** — customer name, status, assigned rep, campaign tag, lead created date, days since last activity. Status dropdown to advance the lead. Reassign button (admin only).
- **Customer summary panel** — pulled from `sf_customers` and joined mirror tables: address, phone(s), email(s), last serviced date, account balance, lifetime spend (revenue), VIP flag, equipment on file, referral source. All clickable phone numbers (Dialpad extension will handle click-to-call once you install it; nothing extra for us to build).
- **Engagement panel** — opens count + timestamps, clicks count + timestamps, which tracked links were clicked (if Mailchimp returns this), the campaign's subject line.
- **Service Fusion job history** — list of this customer's past jobs from `sf_jobs`: date, category, total, status. Useful context: is this someone who's bought big-ticket items before, or a service-call-only customer?
- **Call log** — list of `sales_calls` for this lead, newest first. Each entry shows the rep who made it, the disposition, duration, and notes. Reps see all calls on the lead, including those from other reps (per owner decision).
- **Notes log** — free-text notes (`sales_notes`), newest first, with author and timestamp.
- **Status history** — collapsed by default; expand to see the full audit trail.

### 5.4 Logging a call

A prominent **"Log Call"** button on the lead detail screen opens a modal:
- **When** — defaults to now; editable.
- **Disposition** — required; dropdown of active dispositions.
- **Duration** — optional minutes field.
- **Notes** — free text.
- If the disposition implies a status change (e.g., "Closed Won"), the modal shows: "This will move the lead to Closed Won — confirm?" and on save, advances the status.

Saved calls update the lead's `last_activity_at` and may advance the status per §4.3.

### 5.5 Adding a note

A **"Add Note"** button opens a smaller modal for a free-text note (no call associated). Useful for "Sent quote via email, attaching PDF to record" or "Customer's wife handles the appointments, call after 5."

---

## 6. Closed Won → Service Fusion Handoff Screen

When a lead is marked **Closed Won**, a special "Ready for SF Handoff" view becomes available for it. Reps land here automatically after marking Closed Won; admins can also reach it from the master list.

### 6.1 Layout — designed for "look at this, switch to SF, copy the job in"

The screen is structured so a rep can have it on one half of their monitor and Service Fusion on the other:

**Top — customer identifiers (large, copy-friendly):**
- **Customer name** (large)
- **Service Fusion Account Number** (large, with a one-click "Copy" button) — this is the human-readable identifier reps type into SF's search.
- **Service Fusion Customer ID** (smaller, fallback) — shown in case the account number is empty for this customer.
- Reminder text: *"These are existing SF customers — search by account number in SF, then create the new job under their record."*

**Customer details:**
- Primary address (with copy button)
- Primary phone (with copy button — also click-to-call if Dialpad extension is installed)
- Primary email
- Last serviced date

**Job context for the rep to enter in SF:**
- Campaign / tag that drove the lead
- Full call log for this lead (so the rep can summarize the conversation in SF's job notes)
- Equipment on file (so the rep knows what work the existing setup involves)
- A free-text **"Job notes to enter in SF"** field the rep filled out when marking Closed Won

**Confirmation action:**
- A single button: **"Mark SF job as created"**. This sets `sf_job_created = true` and `sf_job_marked_created_at = now` on the lead. It does not write to SF.

### 6.2 Open handoff alert

Per the prior PRD's alerts framework, add a **sixth operational alert**: **"Closed Won — Awaiting SF Job"**. Lists every lead where `closed_outcome = 'won'` and `sf_job_created = false`. Sorted by `closed_at` ascending (oldest first). This is the safety net that catches deals where the rep won, got distracted, and never created the SF job.

If/when the daily SF sync detects that this customer now has a *new* job in SF created after `closed_at`, the alert can optionally auto-resolve — but the explicit "Mark SF job as created" button is the cleaner signal. Both paths are acceptable; explicit button takes precedence.

---

## 7. Admin Controls (in addition to everything in §5.1)

- **Tracked campaigns:** an admin screen to see all auto-detected campaigns, mark/unmark which are tracked, and view per-campaign sync stats.
- **Pipeline configuration:** edit the list of statuses and dispositions. New statuses can be added; existing ones can be renamed; deletion only allowed if no leads currently use that value (otherwise show a count and prevent deletion).
- **Assignment view:** quick UI to bulk-assign filtered leads to a rep (e.g., "Take all Spring Tune-Up openers in 92025 and 92027 and give them to Sarah").
- **Unmatched engagements panel** (§3.4) — review Mailchimp engagements that didn't match any customer in the mirror, manually link to a customer record, or dismiss.

---

## 8. Sync, Privacy, and Edge Cases

- **Privacy / Apple MPP caveat:** Mailchimp open data includes Apple Mail Privacy Protection pre-fetched opens, which can inflate counts. The sync stores raw Mailchimp data as-is; we do not try to filter MPP opens (Mailchimp's own filter is opt-in and imperfect). Reps should treat opens as a directional signal, not proof of intent — clicks are the stronger signal. This is informational only; no software behavior change.
- **Unsubscribed/cleaned recipients:** if a recipient unsubscribed in Mailchimp, their engagement is still imported (they may have opened *before* unsubscribing) but the lead detail screen surfaces an "unsubscribed in Mailchimp" badge so the rep doesn't email them again.
- **Re-engagement:** if a customer opens a second campaign later, a *new* lead is created (per §4.1), independent of any earlier lead. The customer's history panel shows past leads for context.
- **Deletion:** if a customer is deleted in SF and soft-deleted in the mirror, their open leads display a warning. Admin can choose to close the lead with reason "customer removed from SF" or leave it.

---

## 9. Acceptance Criteria

1. The `sales` role exists and a user with that role can log in and see only the Sales tab.
2. A sales user sees only leads assigned to them; an admin sees the master list of all leads.
3. The "Sync from Mailchimp" button pulls open and click data for tracked campaigns and creates a new lead for every newly engaged customer.
4. A single customer who opens two tracked campaigns appears as two separate leads, each linked to the same `sf_customers` record.
5. Engagement data correctly matches Mailchimp's own report for at least one sample campaign (recipients, open count, click count).
6. A rep can log a call against a lead with a disposition, duration, and notes; the call appears in the lead's call log; `last_activity_at` updates.
7. Logging a "Closed Won" disposition advances the lead to Closed Won status (with confirmation).
8. The "Ready for SF Handoff" screen displays the customer's SF account number prominently with a copy button, plus all customer detail, call history, and a "Mark SF job as created" button.
9. Marking a lead as having an SF job set the lead's `sf_job_created` flag and removes it from the "Closed Won — Awaiting SF Job" alert.
10. The new alert in §6.2 correctly lists Closed Won leads where `sf_job_created = false`.
11. Admin can edit pipeline statuses and call dispositions.
12. Admin can bulk-assign leads to a rep using the filters in §5.1.
13. Reps can see other reps' calls and notes on shared leads.
14. No v1, v2, Phase 1, or SF Mirror/Mailchimp/Alerts functionality has regressed.

---

## 10. Out of Scope (deferred)

- Automatic background polling of Mailchimp (sync is button-driven only).
- Writing the SF job programmatically (handoff is manual by design).
- Auto-reassignment based on SLA, round-robin, or rep workload.
- Email/SMS notifications to reps (e.g. "new lead assigned to you").
- A rep-facing analytics dashboard (call volume, conversion rate per rep) — out of scope here; will be a separate increment on top of Phase 1 Analytics.
- Two-way Mailchimp sync (we never write to Mailchimp from this feature).
- Click-to-call inside Castle Admin (handled by the Dialpad Chrome extension once installed; nothing to build here).

---

## 11. Open Questions for the Owner

1. **Filtering MPP / bot opens:** Mailchimp offers an opt-in setting to exclude Apple MPP and known bot opens from reports. Do you want the sync to use Mailchimp's filtered numbers, raw numbers, or both (raw stored, filtered displayed)?
2. **Lead expiry:** should an unworked lead automatically convert to Closed Lost after N days of no activity (e.g., 30 days)? Or is the "days since last activity" indicator enough and you'd rather not auto-close?
3. **Per-rep visibility nuance:** confirm that when a *new* lead is auto-created from a Mailchimp sync, it lands as **Unassigned** in the master list until admin assigns it — sales reps don't see it until then. (This matches what you said; calling it out to be sure.)
4. **Bulk assignment by tag:** when admin bulk-assigns "all leads with tag X" to one rep, does that include future leads with that tag (a standing rule), or just the leads that exist at the moment of the action? Standing rules add complexity; I'd recommend a one-shot bulk action for now.

---
*End of PRD.*
