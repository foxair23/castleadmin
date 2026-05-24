# Castle Garage Doors & Gates — Piecework Payroll App
## PRD — Service Fusion Data Warehouse, Mailchimp Lead Sync & Operational Alerts

---

## 1. Purpose

Add three connected capabilities to Castle Admin:

1. **A daily full mirror of the Service Fusion database** into our own Supabase database — a complete, queryable replica of every entity Service Fusion exposes through its API.
2. **A Mailchimp integration** that lets the owner hand-pick contacts from that mirror (filtered by recency, lead source, job type), push them into a Mailchimp audience under a chosen tag, and/or export them as CSV.
3. **Operational alerting** on top of the mirror — surfacing mission-critical conditions, the first being *jobs completed but not yet paid*.

This builds on the existing v1 (manual entry), v2 (SF read-only sync), and Phase 1 Analytics work. **Nothing in those is changed or removed.** This PRD is purely additive.

A note on relationship to Phase 1 Analytics: that PRD created *partial* SF caches scoped to specific dashboard metrics. This PRD creates a *complete* mirror. Where they overlap, the complete mirror is the source of truth — during this build, the Phase 1 dashboard should be re-pointed to read from the full mirror tables, and the partial `sf_*_cache` tables from Phase 1 retired. (See §9.)

The integration remains **read-only against Service Fusion** — every SF call is an HTTP GET. We never write to Service Fusion. (We do write to Mailchimp; that is the one outbound integration.)

---

## 2. Source of Truth: The Service Fusion API

This PRD is written against the official Service Fusion API reference (the PDF provided). Key facts confirmed from that document:

- **Base URL:** `https://api.servicefusion.com/v1`
- **Auth:** OAuth 2.0. Grants supported: `authorization_code` and `client_credentials`. Token endpoint: `https://api.servicefusion.com/oauth/access_token`. We use `client_credentials`.
- **All entities are GET-listable** and support pagination, field selection (`fields`), related-record expansion (`expand`), sorting (`sort`), and filtering (`filters[...]`).
- **Pagination:** `page` (default 1) and `per-page` (default 10, **maximum 50**). Every list endpoint is capped at 50 records per request — this is the single biggest driver of sync design (see §4).
- **Incremental filter:** the `/jobs`, `/estimates`, `/invoices`, and `/customers` endpoints support `filters[updated_date][gte]` / `[lte]` (and `/customers` has `last_serviced_date`). This lets daily syncs pull only what changed.
- **Two documented "Known Issues" we must design around:**
  - **`/jobs` hangs with no `sort` parameter.** Every `/jobs` request **must** include a sort param (e.g. `sort=-start_date`). This is mandatory, not optional.
  - **Equipment has no top-level endpoint.** Equipment is only reachable as a nested resource: `GET /customers/{customer-id}/equipment`. Mirroring all equipment therefore requires iterating every customer.
- **Rate limiting:** the API defines a `429 Too Many Requests` response. The docs do not state a specific numeric limit, so the sync engine must treat 429 as a first-class condition and back off (see §4.4).

### 2.1 Entities to mirror (the complete list)

Every resource the API exposes, to be mirrored in full:

| SF Resource | Endpoint | Notes |
|---|---|---|
| Company / account info | `GET /me` | Single record. |
| Calendar tasks | `GET /calendar-tasks` | |
| Customers | `GET /customers` | Includes `referral_source` (drives Mailchimp) and `account_balance` (total owed by customer). Expand `contacts`, `contacts.phones`, `contacts.emails`, `locations`, `custom_fields`. |
| Customer equipment | `GET /customers/{id}/equipment` | Nested — iterate per customer. |
| Jobs | `GET /jobs` | **Must include `sort`.** Carries per-job money fields directly: `payment_status`, `total`, `due_total`, `cost_total`, `taxes_fees_total`, `drive_labor_total`, `billable_expenses_total`, `payments_deposits_total`. Expand `techs_assigned`, `payments`, `invoices`, `labor_charges`, `products`, `services`, `notes`, etc. |
| Job categories | `GET /job-categories` | Small reference table. |
| Job statuses | `GET /job-statuses` | Reference table; includes `category` (Open/Closed grouping). |
| Estimates | `GET /estimates` | Carries money fields: `payment_status`, `total`, `due_total`, `cost_total`, `taxes_fees_total`. |
| Invoices | `GET /invoices` | Carries `total`, `is_paid` (boolean), `date`, `payment_terms`, `mail_send_date`. Core of the unpaid-jobs alert. |
| Payment types | `GET /payment-types` | Reference table. |
| Sources (lead sources) | `GET /sources` | Reference table for referral attribution. |
| Techs | `GET /techs` | |

Reference tables (categories, statuses, payment types, sources) are tiny and fully re-pulled each day. The large transactional tables (customers, jobs, estimates, invoices, calendar tasks) use incremental sync where possible.

---

## 3. Capability 1 — Daily Full Mirror of Service Fusion

### 3.1 Goal
By the end of each daily run, our Supabase database contains a faithful, complete copy of every record in the Service Fusion account, current as of that run.

**Secondary goal — CRM portability.** This mirror is also intended to serve as an owner-controlled data backup and a starting point for a future CRM migration (e.g. to ServiceTitan). To support that, the mirror is built migration-friendly: every record keeps its full original JSON in `raw_data` (nothing is discarded), original Service Fusion IDs are preserved as primary keys, and deletes are soft (history is never destroyed). This means the data can be exported in full at any time.

**Important caveat on completeness.** This mirror replicates everything the Service Fusion *API* exposes, which is comprehensive (customers, jobs, invoices, estimates, payments, equipment, techs, plus job `pictures` and `documents` via expand). However, an API surface is not always byte-for-byte identical to everything stored in a CRM's web application — some systems keep internal audit logs, certain file attachment types, or UI-only fields that the API does not return. For backup and analytics this mirror is complete and authoritative. For a future migration, treat it as an excellent, near-complete foundation rather than a guaranteed lossless export, and plan a verification pass against the source system at migration time.

### 3.2 Database design

For each SF entity, one Supabase table prefixed `sf_` (e.g. `sf_customers`, `sf_jobs`, `sf_invoices`, `sf_estimates`, `sf_calendar_tasks`, `sf_techs`, `sf_job_categories`, `sf_job_statuses`, `sf_payment_types`, `sf_sources`, `sf_customer_equipment`, `sf_company`).

Each table:
- Uses the SF record `id` as the primary key.
- Stores the **full raw JSON** of the record in a `raw_data` JSONB column — so no field is ever lost, even fields this PRD didn't anticipate.
- **Also** promotes the high-value fields into proper typed columns for fast querying and indexing (e.g. on `sf_jobs`: `status`, `sub_status`, `category`, `customer_id`, `start_date`, `end_date`, `closed_at`, `created_at`, `updated_at`, `total`, etc.). The promoted-column list per table is finalized during build by reading the field enums in the API docs.
- Has bookkeeping columns: `sf_synced_at` (last time we pulled this record), `sf_first_seen_at`, `is_deleted` (see §3.5).

Nested/child data (a job's assigned techs, a customer's contacts and locations, line items on invoices) is stored either as JSONB inside the parent's `raw_data` **and** broken out into child tables where we need to query it relationally — at minimum:
- `sf_job_techs` (job ↔ tech assignments)
- `sf_invoice_line_items`
- `sf_customer_contacts` (with child `sf_contact_emails`, `sf_contact_phones`)
- `sf_customer_locations`
- `sf_job_payments` (individual payments recorded against a job, from the job's `payments` expand)

### 3.2.1 Payment & revenue data — explicitly captured

Tracking whether a customer has paid, and how much each job is worth, is a first-class requirement (it powers the "you owe us money" campaign, the unpaid-jobs alert, and revenue analytics). The API exposes this directly, so the mirror must promote these into typed, indexed columns — not leave them buried in `raw_data`:

**On `sf_jobs` (per-job money — comes straight off the job record, no joins needed):**
- `total` — the job's total dollar value.
- `payment_status` — the job's payment status string.
- `due_total` — amount still owed on the job.
- `payments_deposits_total` — amount already paid/deposited on the job.
- `cost_total` — cost of the job (basis for margin once QuickBooks lands).
- `taxes_fees_total`, `drive_labor_total`, `billable_expenses_total` — supporting breakdown.

**On `sf_invoices`:**
- `total` — invoice amount.
- `is_paid` — boolean: paid or not.
- `date` — invoice date.
- `payment_terms` — terms (drives the "overdue" calculation).
- `mail_send_date` — when the invoice was sent to the customer.

**On `sf_customers`:**
- `account_balance` — the customer's total outstanding balance across all their jobs/invoices. This is the cleanest single number for "does this customer owe us money."

**On `sf_estimates`:** `total`, `due_total`, `cost_total`, `payment_status` (so estimate value is tracked too).

**On `sf_job_payments`:** each individual payment record against a job — amount, date, payment type — so payment history is queryable, not just a running total.

**Derived / roll-up values** the system should compute and keep current (in the mirror or in views on top of it):
- **Total revenue per customer** ("spend per customer" / customer lifetime value) — sum of `total` across that customer's jobs (or paid invoices). This is the figure the analytics dashboard surfaces as how much a customer has spent with Castle over time.
- **Total outstanding per customer** — confirmable two ways: the SF-provided `account_balance`, and our own sum of `due_total` across the customer's jobs. The build should reconcile these and flag mismatches.
- **Paid vs. unpaid status per job** — derived from `payment_status` / `due_total`, used by the unpaid-jobs alert (§6) and as a filter in the Marketing Contacts picker (§5).

These payment fields also become available as **filters in the Marketing Contacts picker** (§5.3) — e.g. "select all customers with an outstanding balance" to run the payment-reminder campaign — and as **dimensions in the Phase 1 analytics dashboard** (revenue per customer, per job, per category).

### 3.3 Sync strategy — incremental daily, with periodic full reconcile

Because every endpoint caps at **50 records per page**, a naive nightly full pull of multi-year data would be tens of thousands of requests. So:

- **One-time initial backfill:** paginate through every entity from the beginning of time. Resumable, progress-tracked, rate-limit-aware. May run for many hours — that's acceptable. (Same pattern as the Phase 1 backfill.)
- **Daily incremental sync (the normal case):** for entities that support `filters[updated_date][gte]`, pull only records updated since the last successful run (with a safety overlap window — pull the last 48 hours, not just 24, to absorb clock skew and missed runs). Upsert by `id`.
- **Daily full pull for small entities:** reference tables (categories, statuses, payment types, sources, techs) and `/me` are small enough to re-pull completely every day.
- **Weekly full reconcile:** once a week, paginate the *entire* set of large entities (not just recent) to catch anything the incremental filter missed and to detect deletions (§3.5). This is the "complete replica" guarantee.
- **Equipment:** because it's nested per customer, equipment is refreshed on the weekly reconcile (iterating all customers), not daily — unless a customer record itself changed, in which case that customer's equipment is refreshed in the daily run.

### 3.4 Mandatory request rules
- Every `/jobs` request includes `sort=-start_date` (or another valid sort field). **Non-negotiable** — the endpoint hangs otherwise.
- `per-page=50` on every list call (the maximum) to minimize request count.
- Use `expand` to pull related data in one call rather than N+1 follow-up calls, wherever the parent endpoint supports it.

### 3.5 Deletion handling
The incremental filter only returns records that still exist. To keep the mirror faithful, the **weekly full reconcile** compares the complete set of IDs returned by SF against the IDs in our tables; any ID we have that SF no longer returns is marked `is_deleted = true` (soft delete — we never hard-delete, so history is preserved for analytics).

### 3.6 Sync orchestration & observability
- Runs as a scheduled job (Vercel Cron / Supabase scheduled function). Daily incremental at a fixed early-morning Pacific time; weekly reconcile on a chosen low-activity day.
- A `sf_sync_runs` table logs every run: type (incremental/reconcile/backfill), entity, start/end time, records pulled, records upserted, pages fetched, success/failure, error detail.
- An admin screen **"Service Fusion Sync"** shows: last successful run per entity, record counts per table, current backfill progress, and any failures. Includes a manual "Run sync now" button and a "Re-run backfill" button.

---

## 4. Capability 1 — Technical Requirements

### 4.1 Auth
- `client_credentials` OAuth flow. `SF_CLIENT_ID` / `SF_CLIENT_SECRET` stored as Vercel environment variables, never in source or database.
- Access token fetched from the token endpoint, cached server-side, refreshed on expiry or on a `401`.

### 4.2 Where the code runs
All SF calls are server-side (Next.js route handlers / scheduled functions). Credentials never reach the browser. The mirror tables are protected by Row-Level Security so only admins can read them.

### 4.3 Read-only enforcement
The SF client module exposes only GET methods. No POST/PUT/PATCH/DELETE to SF is implemented anywhere. A unit test asserts the SF client only ever issues GET requests. (This was carried over from v2; extend the same `CrmProvider` abstraction so a future ServiceTitan swap stays contained.)

### 4.4 Rate limiting & resilience
- On `429`: exponential backoff with jitter; respect a `Retry-After` header if present; resume from the same page.
- On `5xx` / network error: retry a few times with backoff, then fail the entity for this run and log it — other entities continue.
- The backfill is **resumable**: persist "last completed page" per entity so an interrupted backfill picks up where it left off.
- A configurable politeness delay between requests so we stay well under SF's (undocumented) limit.

### 4.5 Idempotency
All writes are upserts keyed on the SF `id`. Re-running any sync is always safe and never duplicates.

---

## 5. Capability 2 — Mailchimp Lead Sync (tag-based, owner-controlled)

### 5.1 Goal
Let the owner select specific contacts from the Service Fusion mirror and push them into a Mailchimp audience with a chosen tag, so the owner can then send a targeted campaign to that tag from within Mailchimp. Campaign creation and sending stay in Mailchimp; Castle Admin's job is getting the right people, correctly tagged, into the audience. A CSV export of any selected batch is also provided as a fallback.

This is **not** an automatic full-list sync. Pushes are deliberate, owner-initiated actions on a hand-picked batch.

### 5.2 What a "contact" is
A contact is derived from a customer record in the SF mirror that has at least one usable email address (via expanded `contacts.emails`) and/or a phone number. Each contact carries:
- Email (the merge target)
- First name, last name
- Phone number(s)
- Lead source / `referral_source` (joined to `sf_sources`) — pushed to a Mailchimp merge field for segmentation
- City / postal code — pushed to merge fields for geographic segmentation
- `last_serviced_date` — pushed to a merge field
- Outstanding balance (`account_balance`) — pushed to a merge field, so a reminder campaign can reference the amount owed

### 5.3 The Contact Picker (new admin screen)

A screen titled **"Marketing Contacts"** where the owner builds a batch:

**Filters** (combinable):
- **Recency** — by `last_serviced_date` (e.g. "serviced in the last 12 months", custom date range).
- **Lead source** — by `referral_source` (multi-select from the `sf_sources` reference list).
- **Job type / category** — by the job categories the customer has had work in (joined via `sf_jobs` → `sf_job_categories`).
- **Payment status** — by whether the customer has an outstanding balance (`account_balance > 0`, or unpaid `due_total` on their jobs). This is what powers a "you owe us money" reminder campaign — select all customers who currently owe, push them with a tag like `balance-due-reminder`, and send the reminder from Mailchimp.

**Results table** shows matching contacts: name, email, phone, city, lead source, last serviced date, **and outstanding balance**. Each row has a checkbox; "select all matching" is available. A running count of selected contacts (and total dollars outstanding, when the payment filter is in use) is shown.

The owner refines filters, selects the contacts they want, then chooses one of two actions:

### 5.4 Action A — Push selected batch to Mailchimp
- The owner is **required to enter a tag name** for the batch (e.g. `spring-2026-tuneup`, `escondido-gate-customers`). The push will not proceed without a tag — this is mandatory.
- The selected contacts are upserted into the configured Mailchimp audience via Mailchimp's "add or update" by email.
- All pushed contacts are created/updated with **`subscribed`** status (per owner decision), and the batch tag is applied to every contact in the batch.
- Merge fields (lead source, city, postal code, last serviced date) are populated/updated.
- **Consent safety still applies in one direction:** if a contact already exists in Mailchimp as `unsubscribed` or `cleaned`, the push updates their merge fields and tag but does **not** flip them back to `subscribed`. Mailchimp itself blocks re-subscribing a contact who opted out; the system must handle that response gracefully rather than erroring.
- After the push, a summary is shown: added / updated / skipped (already unsubscribed) / failed, with per-contact detail.
- Every push is recorded in a `mailchimp_push_log` table: timestamp, tag used, filter criteria, contact count, per-contact results.

The owner then goes into Mailchimp and sends their campaign to the tag. (Campaign building stays in Mailchimp.)

### 5.5 Action B — Download batch as CSV
- The same selected batch can be exported as a CSV file instead of (or in addition to) pushing to Mailchimp.
- CSV columns: email, first name, last name, phone, city, postal code, lead source, last serviced date — formatted for direct import into Mailchimp or any other email tool.
- This is the worst-case fallback if the Mailchimp API integration is unavailable, and a general-purpose export.

### 5.6 Technical
- Mailchimp Marketing API. API key + audience ID + server prefix stored as Vercel environment variables.
- All Mailchimp calls are server-side. Batch pushes use Mailchimp's batch/bulk operations where contact counts are large, with the same 429/backoff resilience as the SF sync.
- Admin screen **"Mailchimp"** (settings) shows: connection status, the target audience, a "Test connection" button, and the history from `mailchimp_push_log`.
- This is the **only** outbound write integration in the system; it writes to Mailchimp only, never to Service Fusion.

### 5.7 Out of scope for this capability
- Designing or sending campaigns (done in Mailchimp itself).
- Automatic/scheduled full-list syncing — pushes are always owner-initiated batches.
- Two-way sync (Mailchimp → our DB). One direction only.
- Automations / journeys.
- Managing or assigning Mailchimp campaigns from inside Castle Admin (tag-based handoff only).

### 5.8 Deliverability note (non-blocking, for owner awareness)
Per owner decision, pushed contacts use `subscribed` status. Recommended practice — not enforced by the software — is to send first to recently serviced customers rather than the entire historical list at once, which the recency filter in §5.3 directly supports. Bulk-emailing a large inherited list of older addresses risks spam complaints and degraded deliverability for all of Castle's email. This is a business/compliance consideration, not a technical one; a one-time review with an email-compliance resource is advisable before the first large send.

---

## 6. Capability 3 — Operational Alerts

### 6.1 Goal
Surface mission-critical business conditions from the mirror so nothing falls through the cracks. Built as a small, extensible framework: each alert is a self-contained rule (a query against the mirror + a definition of what counts as actionable + a display config) plugged into a shared "Action Items" screen. Five alerts ship in this build; the framework makes future alerts cheap to add.

### 6.2 The Action Items screen
A single admin screen, **"Action Items"**, that hosts all alerts. Each alert renders as its own section with:
- A title and a count badge (how many items currently need attention).
- A sortable table of the flagged items.
- Where money is involved, a total-dollars figure for that alert.
- Aging buckets (0–7 / 8–30 / 30+ days) where time matters.

All alerts are recomputed daily from the mirror, immediately after the sync completes. The owner can also trigger a recompute manually.

### 6.3 The five alerts

**Alert 1 — Completed but Unpaid Jobs**
Jobs that are completed (status in the "Closed Jobs" / completed category per `sf_job_statuses.category`) but still have money owed.
- Logic: find completed jobs; flag any where `due_total > 0` or the linked invoice's `is_paid` is false.
- Columns: customer, job number, completion date, days outstanding, invoice number, amount due, assigned tech.
- Shows total dollars outstanding. Sortable by amount and by age.

**Alert 2 — Completed but Never Invoiced**
Jobs that are completed but have no invoice at all. This is a *different problem* from Alert 1 — it's "go create the invoice," not "go collect." Kept separate deliberately.
- Logic: find completed jobs with no linked record in `sf_invoices`.
- Columns: customer, job number, completion date, days since completion, job total, assigned tech.
- Shows total uninvoiced dollars. Sortable by amount and by age.

**Alert 3 — Stale Estimates (sent, no response)**
Estimates that were sent to a customer but haven't been accepted or declined within a threshold number of days.
- Logic: find estimates whose status indicates "sent"/pending (not accepted, not declined) where the estimate date is older than the staleness threshold (default 14 days — see Open Questions).
- Columns: customer, estimate number, date sent, days outstanding, estimate total, assigned tech.
- Shows total dollar value of stale pipeline. Sortable by amount and by age.

**Alert 4 — Jobs Flagged for Follow-Up**
Jobs the team explicitly marked as needing follow-up, using Service Fusion's `is_requires_follow_up` field on the job.
- Logic: find jobs where `is_requires_follow_up` is true and the job is not yet closed/resolved.
- Columns: customer, job number, job date, status, assigned tech, note to customer / tech notes.
- Sortable by date.

**Alert 5 — Customers Overdue Past Payment Terms**
Customers who owe money *and* are past their agreed payment terms — the genuinely overdue accounts, as opposed to invoices that are simply unpaid but still within terms.
- Logic: for customers with `account_balance > 0`, check their unpaid invoices' `date` against the invoice `payment_terms`; flag customers with at least one invoice now past its terms-implied due date.
- Columns: customer, total balance, oldest overdue invoice date, days overdue, payment terms.
- Shows total overdue dollars across all customers. Sortable by amount and by days overdue.
- Note: this is the alert most directly paired with the "you owe us money" Mailchimp campaign — the same overdue customers can be selected in the Marketing Contacts picker (§5.3) via the payment-status filter.

### 6.4 Alert framework structure
Each of the five alerts is implemented as a self-contained unit so a sixth, seventh, etc. can be added later without touching the others or the shared screen:
- A query/rule (what to look for in the mirror).
- An "actionable" definition (thresholds, what counts as still-open).
- A display config (title, columns, whether to show a dollar total, whether to show aging buckets).
The Action Items screen iterates over the registered alerts and renders each. Adding an alert = adding one new unit to the registry.

### 6.5 Notifications
This build is **screen-based** — the Action Items screen is where alerts live. An optional daily email digest of new action items is noted as a future enhancement, not built now (see Open Questions).

---

## 7. Architecture Summary

```
Service Fusion API  ──GET only──►  Sync Engine  ──►  Supabase mirror (sf_* tables)
                                                          │
                          ┌───────────────────────────────┼───────────────────────────┐
                          ▼                               ▼                           ▼
                   Phase 1 Dashboard          Marketing Contacts picker        Operational Alerts
                   (reads mirror)             (owner picks batch ──►            (Action Items screen)
                                               tag push to Mailchimp,
                                               or CSV download)
```

- The mirror is the single internal source of truth. Every downstream feature reads from it; none of them call SF directly.
- One inbound integration (SF, read-only) and one outbound integration (Mailchimp, write).

---

## 8. Acceptance Criteria

1. The one-time backfill populates every `sf_*` table with all available history; it is resumable and shows progress in the admin UI.
2. The daily incremental sync runs on schedule, pulls only changed records for large entities, fully refreshes small reference tables, and logs every run in `sf_sync_runs`.
3. The weekly reconcile detects records deleted in SF and marks them `is_deleted = true` without removing history.
4. Every `/jobs` request issued by the system includes a `sort` parameter (verified by test/log inspection); no `/jobs` request hangs.
5. Customer equipment is mirrored via the nested per-customer endpoint.
6. Every record in every mirror table retains its full original JSON in `raw_data`, in addition to promoted typed columns.
7. Payment and revenue fields are captured as typed, indexed columns: per-job `total` / `payment_status` / `due_total` / `payments_deposits_total`, invoice `is_paid`, and customer `account_balance`. Total revenue per customer and total outstanding per customer are computable from the mirror and reconcile against SF's own `account_balance`.
8. A code review and unit test confirm the SF client issues only HTTP GET requests.
9. The system handles a `429` from SF by backing off and resuming without data loss.
10. The Marketing Contacts picker filters the mirror by recency, lead source, job category, and payment status (outstanding balance); the owner can select a batch, is required to enter a tag, and pushes the batch to Mailchimp as `subscribed` with the tag applied. Contacts already unsubscribed in Mailchimp are not re-subscribed. Every push is logged.
11. The same selected batch can be downloaded as a correctly formatted CSV.
12. The Action Items screen renders all five alerts — completed-but-unpaid jobs, completed-but-never-invoiced jobs, stale estimates, follow-up-flagged jobs, and customers overdue past payment terms — each with correct items, counts, aging, and dollar totals where applicable, verified against a manual check in Service Fusion.
13. The Service Fusion Sync, Mailchimp, Marketing Contacts, and Action Items admin screens all render and their action buttons work.
14. No v1, v2, or Phase 1 functionality has regressed; the Phase 1 dashboard reads correctly from the new full mirror.

---

## 9. Migration Note: Phase 1 Caches

Phase 1 Analytics created partial caches (`sf_jobs_cache`, `sf_invoices_cache`, etc.) and the `sf_job_schedule_history` / reschedule-tracking logic. With this PRD:
- The full `sf_*` mirror **supersedes** the partial `sf_*_cache` tables. Re-point the Phase 1 dashboard queries to the mirror, then retire the `_cache` tables.
- **Keep `sf_job_schedule_history` and the reschedule-detection logic** — that captures change history the plain mirror does not, and the daily mirror sync is the natural place to run that same detection. Fold the reschedule-detection step into the daily job sync.
- `dashboard_annotations` is unaffected — keep as is.

This migration should be done carefully and verified (criterion 12) so the dashboard doesn't regress.

---

## 10. Out of Scope

- Writing anything back to Service Fusion (read-only, always).
- Real-time / webhook-driven sync (SF's documented model here is polling; daily is sufficient for the stated needs).
- Designing or sending Mailchimp campaigns or automations.
- Two-way Mailchimp sync.
- Email/SMS push notifications for alerts (screen-based for now).
- ServiceTitan (the `CrmProvider` abstraction keeps a future swap contained; the second provider is a separate project).

---

## 11. Open Questions for the Owner

1. **Mailchimp audience.** Do you already have a Mailchimp account and an audience set up, or do we need to create one? Which audience should batches go into?
2. **Stale estimate threshold.** Alert 3 flags estimates with no response after a number of days — default is 14. Is 14 right, or do you want a different window (e.g. 7 or 21)?
3. **Email digest.** Do you want a daily email summarizing new action items, or is checking the screen enough for now?
4. **Sync timing.** What time of day is lowest-activity for your business? That's when the daily sync and weekly reconcile should run.

*Resolved:* Pushed Mailchimp contacts use `subscribed` status. The Mailchimp feature is tag-based (pick contacts in Castle Admin, push with a required tag, send the campaign in Mailchimp); contact picker filters are recency, lead source, job type/category, and payment status; CSV export of any selected batch is included. Operational alerts: five alerts ship in this build — completed-but-unpaid jobs, completed-but-never-invoiced jobs (separate alerts, by design), stale estimates, follow-up-flagged jobs, and customers overdue past payment terms. The "overdue" alert (Alert 5) only counts customers genuinely past their payment terms, not merely unpaid-within-terms.

---
*End of PRD.*
