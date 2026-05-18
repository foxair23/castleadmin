# Castle Garage Doors & Gates — Online Scheduler PRD

**Owner:** John (Castle Garage Doors & Gates)
**Date:** May 17, 2026
**Status:** Draft v1 — ready for Claude Code handoff
**Target site:** castlegaragedoors.com (Next.js App Router, Tailwind)

---

## 1. Overview

Build an online appointment scheduling experience for castlegaragedoors.com that lets customers book service for both **garage doors and gates**. Bookings are captured as "pending" jobs through the **Castle Admin app**, which routes them to **Service Fusion** after office approval. This protects dispatch from bad bookings while still capturing leads 24/7.

This document is a handoff spec for engineering (Claude Code). It defines the user flow, system architecture, data model, edge cases, and phasing.

---

## 2. Goals

- **Capture leads 24/7** without requiring a phone call
- **Differentiate from competitors** (A1 and Precision) by featuring gate service prominently from the very first screen
- **Protect operations** by requiring office review before jobs hit the dispatch board
- **Never drop a lead.** Castle Admin is the system of record for every submission. Even if Service Fusion is down, unreachable, or rejects a write, the lead is preserved and queryable, with clear retry tooling.
- **Stay portable** — architecture must survive a future migration from Service Fusion to ServiceTitan without redoing the customer-facing scheduler

---

## 3. Non-Goals (v1)

- Real-time technician availability or auto-assignment
- Payment collection during booking
- Customer login or account management
- Customer self-service rescheduling/cancellation (must call office for now)
- SMS/email confirmations (handled separately by Service Fusion's existing automations once the job is synced)
- Multi-language support (English only in v1; Spanish in v1.1)

---

## 4. Competitive Context

Two competitors offer online booking:

- **A1 Garage Door Service** — Collects contact info first, then address, then walks through a decision tree (repair vs replace → diagnostic questions → age of door). Real time slots, $0 trip charge offer, photo upload supported. ~6 screens.
- **Precision Door Service** — Starts with the issue (Repair/Install/Maintenance), then sub-issues, then contact info, then schedule. 2-hour time windows, no upfront pricing incentive. ~8 screens.

**Our edge:** Neither competitor features gate service. Putting Garage Door vs. Gate on screen 1 immediately signals that we serve both, which is rare and valuable in this market.

---

## 5. User Flow

### Entry Point
The scheduler is **embedded** on castlegaragedoors.com via a snippet generated in Castle Admin (see Section 6, "Embed & Widget Instances"). On the main site, a "Book Online" CTA in the header opens the scheduler — either as an iframe modal on desktop, a full-screen takeover on mobile, or inline on a dedicated `/book` page (John's choice when he embeds it).

The same snippet can be embedded on any other property John controls (landing pages, partner sites, etc.), each with its own `lead_source` for attribution.

### Step 1 — Service Type *(this is our differentiator)*

**Heading:** "What can we help you with?"

Two large tappable cards:
- 🏠 **Garage Door**
- 🚪 **Gate**

→ Branches into the garage door path or gate path.

---

### Garage Door Path

#### Step 2A — Service Category
**Heading:** "What kind of service do you need?"

- Repairs & Service
- Door/Panel Replacement
- New Installation
- Maintenance / Tune-up

#### Step 3A — Diagnostic Questions (conditional on Step 2A)

**If Repairs & Service:**
- *Are you able to open and close your door?* (Yes / No)
- *What's the issue?* (multi-select, optional)
  - Won't open or close
  - Loud or grinding noise
  - Off track
  - Broken spring
  - Remote or keypad not working
  - Visible damage
  - Other

**If Door/Panel Replacement:**
- *What type of door are you looking for?*
  - Something basic and functional
  - Something nicer with more features
  - Not sure yet — I'd like recommendations

**If New Installation:**
- *Is this for new construction or replacing an existing door?*
  - New construction
  - Replacing existing

**If Maintenance:**
- (No additional questions — proceed to Step 4A)

#### Step 4A — Universal Garage Door Questions
- *What is the estimated age of your garage door?*
  - Less than 8 years old
  - 8 years or older
  - Don't know
- *Do you have more than one garage door?* (Yes / No)

---

### Gate Path *(recommended flow — review and edit)*

#### Step 2B — Service Category
**Heading:** "What kind of gate service do you need?"

- Repairs & Service
- New Installation
- Maintenance / Tune-up

#### Step 3B — Gate-Specific Questions

**If Repairs & Service:**
- *What type of gate?*
  - Swing gate
  - Sliding gate
  - Pedestrian / walk-through gate
- *What's the issue?* (multi-select)
  - Gate won't open or close
  - Motor / operator issue
  - Remote, keypad, or intercom not working
  - Visible damage to gate
  - Hinges or hardware issue
  - Power / electrical issue
  - Other

**If New Installation:**
- *What type of gate?*
  - Swing gate
  - Sliding gate
  - Driveway gate
  - Pedestrian gate
- *Material preference?*
  - Wrought iron
  - Wood
  - Aluminum or steel
  - Not sure — need recommendations
- *Will it need an automatic opener?*
  - Yes
  - No
  - Not sure

**If Maintenance:**
- (No additional questions — proceed to Step 4B)

#### Step 4B — Universal Gate Questions
- *How old is the gate?*
  - Less than 5 years old
  - 5 years or older
  - Don't know
- *Do you have more than one gate?* (Yes / No)

---

### Step 5 — Contact Information *(shared across both paths)*

- First Name *(required)*
- Last Name *(required)*
- Phone *(required, US format, formatted as user types)*
- Email *(required, validated)*
- ☐ "I agree to receive text messages about this appointment" (TCPA-compliant copy below the checkbox)

### Step 6 — Service Address

- Address Line 1 *(required)*
- Address Line 2 — Apt/Unit (optional)
- City *(required, can be auto-filled from zip)*
- State *(required, default: CA)*
- Zip Code *(required, validated)*
- ☑ "I am the owner of this property" (pre-checked)

**Service area check:**

Service area is defined by a **list of cities** maintained in Castle Admin → Settings. At launch, this list is pre-populated with **all incorporated and unincorporated communities in San Diego County + Riverside County** (sourced from USPS data); John can prune the list as he learns which cities are actually serviceable.

The zip code list is **auto-derived** from the city list using a USPS city↔zip mapping. The zip list is read-only in Settings (shown for transparency) and refreshes whenever the city list changes.

**How the check runs at submission time:**
1. Customer enters address (zip and city).
2. Scheduler checks both: (a) is the zip in the derived zip list? (b) does the city match a city in the configured list?
3. If either matches, treat as in-service-area.
4. If neither matches, flag as out-of-service-area.

(Using both signals catches edge cases where USPS city/zip data is messy — a customer in an unincorporated area might enter a city name that doesn't match their zip's USPS-canonical city.)

If the customer is **not** in the service area, the scheduler displays a warning *but does not block booking*:

> "Heads up — your area may be outside our normal service zone. You can still submit your request, and our team will reach out to confirm whether we can service your location. If you'd prefer to talk to someone now, give us a call at (760) XXX-XXXX."
>
> [Continue with booking] [Call us instead]

If the customer proceeds, the lead is flagged `in_service_area: false` and the office sees a clear visual indicator on the lead in the Castle Admin Leads inbox. This lets the office decide case-by-case — sometimes a customer is 10 minutes outside a city boundary and absolutely worth servicing.

**Auto-sync interaction:** When `sync_mode = auto` and the in-service-area safeguard is on (both default), out-of-area leads do NOT auto-sync to Service Fusion. They fall back to manual review regardless of sync mode. This protects against accidentally dispatching a tech 90 minutes away because nobody looked at the booking.

### Step 7 — Schedule

**Heading:** "When do you need us?"

- Horizontal date picker showing next 14 days (configurable)
- For each date, show available time windows
- v1 default windows: **8 AM – 12 PM** and **12 PM – 4 PM** (configurable)
- Sundays disabled by default (configurable)

### Step 8 — Additional Details *(optional)*

- Description text field: "Tell us more about what's going on" (optional, multi-line)
- File upload: photos/videos of the issue
  - Accepted: jpg, jpeg, png, heic, mp4, mov, webp, webm
  - Max 5 files, 25 MB total
  - Files stored in our own cloud storage; URLs included in the job notes

### Step 9 — Incentive Display

Banner above the Review step:
> 🎉 **$50 off your first service** when you book online.
> *Applied automatically. (Configurable amount and copy.)*

### Step 10 — Review & Confirm

Summary card showing:
- Service type and category
- Diagnostic answers
- Contact info
- Address
- Selected date and window
- Description and uploaded files

Each section has a pencil icon to edit without losing progress.

Required:
- ☐ "I agree to the [Terms of Service]" — links to the existing ToS page

Optional:
- ☐ "I'd like to hear about promotions and tips by SMS" (marketing opt-in, separate from appointment SMS)

CTA: **[Book Appointment]**

### Step 11 — Confirmation

- "Thanks, {firstName}! Your request has been received."
- Show appointment window, address, and confirmation number (e.g., `CGD-2026-00012`)
- "Our team will reach out within 2 business hours to confirm your appointment."
- Buttons: [Add to Calendar (.ics)] [Done]

---

## 6. Architecture

### Recommended approach: Hosted scheduler embedded on the site, backed by Castle Admin

```
[Customer browser on castlegaragedoors.com]
              ↓ (embedded iframe / script)
[Hosted scheduler — schedule.castlegaragedoors.com (Next.js)]
              ↓ HTTPS API call (with widget instance ID)
[Castle Admin app (server) — source of truth]
              ↓ Service Fusion REST API (on office approval)
[Service Fusion CRM]
```

The scheduler is a small, self-contained Next.js app hosted at its own subdomain (proposed: `schedule.castlegaragedoors.com`). It's embedded into the main site via an iframe or script snippet. This isolation means:

- The main marketing site can be deployed independently
- The scheduler can be embedded anywhere (multiple sites, landing pages, partner pages) without recreating it
- Each embed carries a `widget_instance` ID, which determines the `lead_source` value

**Why route everything through Castle Admin** (vs. scheduler calling Service Fusion directly):

1. Service Fusion API credentials live in only one place (Castle Admin)
2. Settings (time windows, incentive copy, service area zips, widget instances) live in Castle Admin and the scheduler fetches them at load time
3. The "pending approval" workflow happens in Castle Admin — Service Fusion only sees the final approved job
4. **Castle Admin is the system of record.** Every lead is preserved there even if Service Fusion is down or rejects the write.
5. Future migration to ServiceTitan only touches Castle Admin; the public scheduler is unaffected
6. Public scheduler has no CRM credentials, reducing attack surface

### Data flow

1. **Scheduler loads** → fetches config from Castle Admin (`GET /api/scheduler/config`)
   - Returns: time windows, service area zips, incentive copy, business hours, booking horizon, lead source value (for the widget instance)
2. **Customer completes flow** → POSTs to Castle Admin (`POST /api/scheduler/bookings`)
   - Any photos/videos are uploaded to **Castle Admin's temporary storage** at submission time (because Service Fusion's job doesn't exist yet — it's not created until sync)
3. **Castle Admin writes the lead to its database FIRST** with status `pending`, generates confirmation number, sends notification to office (email + in-app). *This write is the source of truth. The customer is shown success based on this write completing — not on Service Fusion.*
4. **What happens next depends on the `sync_mode` setting** (configurable in Castle Admin → Settings):

   **Manual mode (default, v1):**
   - Office reviews in Castle Admin → approve / edit / reject
   - On approval, Service Fusion sync runs (see step 5)

   **Auto mode:**
   - Lead is automatically marked `approved` immediately after the Castle Admin write succeeds
   - Service Fusion sync runs in the background (see step 5)
   - Office is still notified, but for awareness, not action
   - Lead still appears in the Leads inbox with full sync visibility — office can edit, retry, or roll back as needed
   - Optional sub-setting: **auto-sync only for in-service-area + non-duplicate leads.** Out-of-area or suspected-duplicate leads still drop into manual review. (Default: on. Configurable.)

5. **Service Fusion sync (same logic regardless of mode):**
   - Castle Admin searches Service Fusion for existing customer (by phone, then email)
   - Creates customer if not found (`POST /customers`)
   - Creates job (`POST /jobs`) with type, scheduled window, address, notes, lead source custom field, attachments
   - Uploads attached photos/videos to the Service Fusion job (verify endpoint — see open questions)
   - Stores returned `service_fusion_customer_id` and `service_fusion_job_id` on the booking
   - Updates `sync_status` to `synced`
   - Temporary file storage in Castle Admin can be purged after a configurable retention period (default 30 days) since files now live in Service Fusion

### Why both modes are supported

- **Manual mode** is safer for launch. The office sees every booking before it hits the dispatch board. Catches spam, out-of-area requests, and obviously-wrong submissions before they become a tech's bad day.
- **Auto mode** is faster for operations. Once John trusts the volume and quality of online bookings, he can flip the switch and bookings flow straight through. The Leads inbox still gives full visibility and rollback if anything goes wrong.

**Migration path:** Start in manual. After 2–4 weeks of clean operation, review the rejection rate. If under 5% of bookings are being rejected as bad, flip to auto mode (with the in-service-area-only safeguard on). The Leads inbox preserves the audit trail either way.

### Castle Admin: new "Scheduler" section

A new top-level **Scheduler** tab is added to Castle Admin (visible only to administrators and office staff with appropriate permissions — not exposed to customers, technicians, or anyone outside the office).

This tab is the single place where John and office staff manage everything about the online scheduler. It contains four sub-pages:

#### 1. Dashboard
Landing view when you click into Scheduler. At-a-glance health:
- Pending review count (action items needing approval)
- Sync failures count (action items needing attention)
- Bookings this week / this month
- Conversion rate trend
- Lead source breakdown (pie chart by `lead_source`)
- Recent activity feed

#### 2. Leads
The full Leads inbox — every booking ever submitted, source-of-truth view.

- **List view** with columns: confirmation #, customer name, service type, appointment window, status, sync_status, lead source, created date
- **Filters:** status, sync_status, date range, service type (garage door / gate), lead source, widget instance, in/out of service area
- **Search:** by name, phone, email, address, or confirmation number
- **Bulk actions:** approve, reject, retry sync, export to CSV
- **Detail view** (click any lead): full submission data, customer info, address, all answers from the question flow, uploaded photos/videos, sync history with timestamps and error messages, internal notes field, approve/reject/edit buttons, manual "mark as synced" button (with required note explaining why)

This is where the **"never drop a lead"** guarantee lives. If anything ever fails between us and Service Fusion, John can see it here and recover it.

#### 3. Embed & Widget Instances
This is where John gets the snippet of code to embed on castlegaragedoors.com (and anywhere else).

**How it works:**
- John creates one or more **widget instances**. Each instance has its own ID, a display name (e.g., "Main website", "Facebook landing page", "Google Business Profile"), and its own `lead_source` value.
- For each instance, Castle Admin generates a copy-paste embed snippet. Two formats offered:

```html
<!-- Recommended: iframe embed -->
<iframe
  src="https://schedule.castlegaragedoors.com/?instance=main_site"
  width="100%"
  height="800"
  frameborder="0"
  title="Book Online — Castle Garage Doors & Gates">
</iframe>
```

```html
<!-- Alternative: button-triggered modal (loads script) -->
<script src="https://schedule.castlegaragedoors.com/embed.js"
        data-instance="main_site"
        defer></script>
<button data-castle-scheduler-open>Book Online</button>
```

- John can preview each instance (opens a new tab loading the live scheduler) to verify it looks right before embedding.
- John can disable an instance (e.g., when a campaign ends) which causes the embed to show a "Scheduler unavailable, please call us" message instead of breaking the page.
- Stats per instance: how many submissions, conversion rate, sync success rate — so John can see which channels are working.

#### 4. Settings
All configuration values from Section 7. Sections within Settings:
- **Availability** — time windows, available days, booking horizon
- **Service area** — zip codes covered (San Diego + Riverside lists, editable)
- **Incentive** — copy and amount
- **Notifications** — office email for new bookings
- **Uploads** — max files, max size, retention policy
- **Consent copy** — TCPA/SMS opt-in text, marketing opt-in text
- **Service Fusion connection** — credentials status, custom field mapping (e.g., which Service Fusion custom field receives the `lead_source` value), test connection button

Every change to Settings is logged with timestamp and user (for audit and so John can see "why did bookings stop coming in last Tuesday — oh, someone disabled the widget").

### Permissions

- **Admin** (John): full access to all four sub-pages, can change settings, manage widget instances, see all leads
- **Office staff:** access to Dashboard and Leads (approve/reject/edit/retry), read-only on Embed and Settings
- **Technicians:** no access to Scheduler tab at all

### Service Fusion API touchpoints

Confirmed available endpoints (REST, Pro plan):
- `GET /customers?search=` — find existing customer
- `POST /customers` — create new customer
- `POST /jobs` — create job
- `POST /estimates` — create estimate (not used in v1, but available)

**Confirmed via Service Fusion documentation:**
- **Custom fields are supported** on Jobs/Estimates, Customers, and Equipment. We will create a custom field called `Lead Source` in Service Fusion (My Office → Custom Fields → Jobs/Estimates) and the API will write to it. Default value `website`; configurable per widget instance.
- **Job Categories** are supported and can be used to tag jobs as "Online Booking" for reporting.

### To verify against the live API docs portal before build:

The Service Fusion docs at `https://docs.servicefusion.com/#/docs/summary` are a JavaScript-rendered API console (MuleSoft); the request/response schemas need to be viewed in a browser. Before kicking off engineering, John or the engineer should open it and confirm:

1. **Job statuses on create:** Can we create jobs in an "Unscheduled" or "Pending Confirmation" status, or do they automatically appear on the dispatch board? (We've already decided to do office approval *before* writing to Service Fusion, which sidesteps this — but worth confirming.)
2. **Attachment upload:** Does Service Fusion's API support uploading files (photos/videos) to a job? What's the endpoint, max file size, accepted MIME types? *John has stated Service Fusion should store the attachments — we need to confirm the API supports this. If not, fallback plan: keep them in Castle Admin storage and include URLs in the job description/notes.*
3. **Custom field write:** Confirm the exact request body shape for setting a custom field value when creating a job.
4. **Rate limits:** Exact per-minute and per-hour limits.
5. **Idempotency:** Does the API support idempotency keys to prevent duplicate jobs on retry? If not, we'll deduplicate by checking for `service_fusion_job_id` on the booking before retrying.
6. **Webhooks:** Does Service Fusion send webhooks back to us when a job's status changes (e.g., completed, cancelled)? Useful for keeping Castle Admin's lead state in sync after the office has handed it off.

---

## 7. Configuration

All settings live in Castle Admin and are editable without code changes:

| Setting | v1 Default | Notes |
|---|---|---|
| Time windows | `8 AM – 12 PM`, `12 PM – 4 PM` | Add/remove/edit windows |
| Available days | Mon–Sat | Sunday toggle |
| Booking horizon | 14 days out | How far ahead customers can book |
| Service area (cities) | All cities in San Diego County + Riverside County (pre-populated at launch; John prunes from there based on real operational experience) | **Cities are the primary list.** Editable in Castle Admin → Settings. Zip codes are auto-derived from the city list using a USPS-sourced city→zip mapping. Out-of-area entries trigger a warning but don't block booking. |
| Service area (zips, derived) | Auto-generated from city list | Read-only in Settings (shown for transparency/debugging). Refreshed whenever the city list changes. |
| Incentive copy | "$50 off your first service" | Editable amount and full text |
| Incentive expiration | None | Optional future feature |
| Marketing SMS opt-in copy | (TCPA standard) | Editable |
| Office notification email | (John's email) | Where new booking alerts go |
| Max file uploads | 5 files, 25 MB total | Editable |
| **Sync mode** | `manual` | **`manual`** = office must approve each lead before it syncs to Service Fusion. **`auto`** = leads are auto-approved on submission and sync immediately. Toggle in Castle Admin → Settings. |
| Auto-sync safeguard: in-service-area only | `on` | When sync mode is `auto`, only auto-sync leads inside the service area. Out-of-area leads still require manual review. |
| Auto-sync safeguard: skip suspected duplicates | `on` | When sync mode is `auto`, leads matching another submission from the same phone+email in the last 24 hours are held for manual review instead of auto-syncing. |
| Lead source | `website` | **Per widget instance.** If the scheduler is embedded somewhere else later (e.g., Facebook ad landing page, Google Business Profile, partner site), each instance can have its own lead source value (`facebook_ad`, `gbp`, `homeadvisor`, etc.). Stored on the lead and written to the Service Fusion `Lead Source` custom field on sync. |
| File retention (Castle Admin) | 30 days after `synced` | How long to keep uploaded files in Castle Admin storage after they've been pushed to Service Fusion |

---

## 8. Data Model

### Booking / Lead record (stored in Castle Admin — source of truth)

```json
{
  "id": "CGD-2026-00001",
  "status": "pending",
  "sync_status": "not_attempted",
  "created_at": "2026-05-17T14:32:00Z",
  "lead_source": "website",
  "widget_instance": "main_site",
  "service_type": "garage_door",
  "service_category": "repair",
  "diagnostic_answers": {
    "can_open_close": "no",
    "issues": ["wont_open", "loud_noise"],
    "age": "8_or_older",
    "multiple_doors": false
  },
  "customer": {
    "first_name": "John",
    "last_name": "Toms",
    "phone": "+18584532518",
    "email": "jim@gmail.com",
    "sms_appointment_consent": true,
    "sms_marketing_consent": false
  },
  "address": {
    "line1": "120 Coast Highway",
    "line2": null,
    "city": "Encinitas",
    "state": "CA",
    "zip": "92024",
    "is_owner": true,
    "in_service_area": true
  },
  "appointment": {
    "date": "2026-05-21",
    "window_start": "08:00",
    "window_end": "12:00",
    "timezone": "America/Los_Angeles"
  },
  "description": "Spring broke this morning, can't get the car out",
  "attachments": [
    {
      "filename": "broken_spring.jpg",
      "castle_admin_url": "https://storage.castlegaragedoors.com/uploads/abc123.jpg",
      "service_fusion_attachment_id": null,
      "size_bytes": 1840293,
      "mime_type": "image/jpeg"
    }
  ],
  "incentive_applied": "$50 off first service",
  "service_fusion_customer_id": null,
  "service_fusion_job_id": null,
  "auto_approved": false,
  "approved_by": null,
  "approved_at": null,
  "rejected_reason": null,
  "sync_attempts": [],
  "synced_at": null,
  "notes_internal": ""
}
```

When `sync_mode = manual`, `approved_by` is the office user who approved and `auto_approved` is `false`. When `sync_mode = auto`, `approved_by` is `null`, `auto_approved` is `true`, and `approved_at` is set to the submission time. This makes the audit trail unambiguous when looking back: you can always tell whether a human or the system approved a given lead.

### Status lifecycle

**Lead status (office workflow):**
- `pending` → `approved` → (sync happens) → terminal
- `pending` → `rejected` (terminal — office decides this isn't a real lead, duplicate, prank, etc.)

**Sync status (Service Fusion handoff, independent of lead status):**
- `not_attempted` (default — lead exists in Castle Admin only)
- `in_progress` (sync running)
- `synced` (Service Fusion has the job)
- `sync_failed` (retryable; see `sync_attempts` for error history)
- `manually_synced` (office marked it synced after creating in Service Fusion outside the API)

Separating these two fields means an `approved` lead with `sync_failed` is clearly visible in the Leads inbox and can be retried, manually synced, or investigated without confusing the workflow status.

Each entry in `sync_attempts` records: timestamp, attempt number, success/failure, error message (if any), and which Service Fusion endpoint failed. This makes debugging dropped leads straightforward.

---

## 9. Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| Service Fusion API down at approval time | Lead stays `approved` with `sync_status: sync_failed`. Background retry with exponential backoff (3 attempts over 24 hours). Lead is visible in Castle Admin Leads inbox with a retry button. Customer experience is unaffected — they already got their confirmation. |
| Service Fusion API down at submission time | Customer never sees this — submission only writes to Castle Admin. Service Fusion isn't touched until approval. |
| Customer already exists in Service Fusion | Match by phone first, then email. Use existing customer ID; do not duplicate. |
| Duplicate booking from same phone+email within 1 hour | Show "Looks like you already booked. Call us to make changes." |
| Outside service area | Warning shown; booking still allowed; flagged for office. |
| Invalid phone format | Inline validation, friendly error. |
| File upload failure | Non-blocking — booking still submits without that file; show toast. |
| Network failure on final submit | Retry 3x with backoff. Preserve form state in localStorage so customer doesn't lose progress on refresh. |
| Bot / spam booking | Honeypot field + rate limit (5 bookings per IP per hour). Consider Cloudflare Turnstile if abuse appears. |
| Customer abandons mid-flow | Save partial state in localStorage for 24 hours so returning customer can resume. |

---

## 10. Design & UX Notes

### Castle design system (required)

The scheduler **must use the existing Castle design system** — the same one used by castlegaragedoors.com and the Castle Admin app. The scheduler should feel like a native part of the Castle ecosystem, not a third-party widget that's been bolted on.

This applies to **both** the customer-facing scheduler at `schedule.castlegaragedoors.com` and the new Scheduler tab inside Castle Admin.

**Inherit and reuse:**
- **Design tokens** — colors (black + red brand palette), typography scale, spacing scale, border radii, shadows, breakpoints. Pull from the existing tokens file used by Castle Admin and the marketing site; do not redefine.
- **Component library** — buttons, form inputs (text fields, selects, checkboxes, radios), modal/dialog patterns, toast notifications, progress indicators, cards, tables, badges, empty states. Reuse the existing components rather than creating new ones. If a needed component doesn't exist yet, build it as a shared component that Castle Admin can also use — not as a one-off for the scheduler.
- **Iconography** — same icon library/set used elsewhere in the Castle ecosystem
- **Voice and tone** — match the copy style of the marketing site (warm, direct, family-business feel, no jargon)
- **Animation and transitions** — match existing patterns; if Castle Admin uses subtle fades on modals, so does the scheduler

**Reference materials:**
- The existing Website Design Guide produced for Castle Garage Doors & Gates
- The Castle Admin codebase (for components and tokens)
- The live castlegaragedoors.com site (for visual style and tone)

**If anything in the existing system is missing or unclear,** flag it as a question before building rather than inventing a new pattern. Drift between scheduler and the rest of Castle is a bug.

### General UX principles

- **Mobile-first:** Most users will be on phones. Single primary question per screen on mobile. Multi-column on desktop only where it adds clarity.
- **Progress indicator:** Segmented bar showing steps completed (similar to Precision's pattern).
- **Tap targets:** Minimum 44×44 px. Customers may be wearing gloves or using one hand outdoors.
- **Back button:** Always visible. Going back never loses entered data.
- **Loading states:** Show skeleton screens or spinners on any step that hits Castle Admin (config fetch, submit). Use the same skeleton/spinner components Castle Admin uses elsewhere.
- **Accessibility:** WCAG 2.1 AA — proper labels, keyboard nav, sufficient contrast, screen reader support.
- **Performance:** Scheduler should load in under 2 seconds on a mid-tier mobile device on 4G.
- **iframe considerations:** Because the scheduler is embedded via iframe on the main site, ensure responsive behavior works inside the iframe (auto-height resize message to parent, or fixed-but-scrollable container).

---

## 11. Phasing

### v1 — MVP (target: 4–6 weeks)
- Garage Door + Gate flows with all questions specified above
- Full contact + address + scheduling
- Photo/video upload (up to 5 files), stored in Castle Admin then pushed to Service Fusion on approval
- Hosted scheduler app at `schedule.castlegaragedoors.com`
- New **Scheduler** tab in Castle Admin with four sub-pages:
  - **Dashboard** with health metrics
  - **Leads** inbox (full filtering, search, sync history, manual retry, manual mark-as-synced, CSV export)
  - **Embed & Widget Instances** (snippet generator, instance management, per-instance stats)
  - **Settings** (all configurable values including **sync mode toggle** (manual / auto) and safeguards, with audit log of changes)
- Service Fusion sync logic (same in both modes): customer + job + custom lead source field + attachments
- v1 launches with `sync_mode = manual` as the default; auto mode is built and tested but turned off until John flips it on
- Email notification to office on new booking (always, in both modes)
- Role-based permissions (admin / office staff / no access)

### v1.1 — Polish (next 30 days after v1)
- SMS confirmation to customer on submission ("Got your request, we'll call within 2 hours")
- SMS notification when office approves (with appointment details)
- Calendar invite (.ics) download
- Spanish language toggle (important for San Diego market)
- Honeypot + rate limit

### v2 — Future
- Real-time tech availability (if/when Service Fusion API supports it, or via ServiceTitan after migration)
- Customer self-service reschedule/cancel
- Estimated price ranges for common services
- AI photo analysis to suggest likely issues
- Booking from Google Business Profile / Yelp integrations

---

## 12. Open Questions for Engineering

1. **Cloud storage for uploads (Castle Admin side):** Recommend Cloudflare R2 (cheaper egress) vs AWS S3 for the temporary attachment store. Pick one.
2. **Castle Admin endpoints:** Need to design and document the new `/api/scheduler/config` (GET) and `/api/scheduler/bookings` (POST) endpoints, plus the file upload endpoint. Include auth model (public read for config, signed token or origin check for booking POST).
3. **Verify Service Fusion API endpoint specs:** The docs portal is JS-rendered and needs to be opened in a browser. Specifically confirm: (a) attachment upload endpoint and limits, (b) request body for setting custom field values on job create, (c) idempotency key support, (d) rate limits, (e) whether webhooks are available for job status changes.
4. **Service Fusion setup:** Before launch, create a `Lead Source` custom field on Jobs in Service Fusion (My Office → Custom Fields → Jobs/Estimates).
5. **Booking ID format:** `CGD-{year}-{sequential 5-digit}` proposed. Confirm acceptable.
6. **Time zone handling:** Assume all bookings are America/Los_Angeles; what if a customer is browsing from elsewhere?
7. **GDPR / CCPA:** California-only business, but we should still have a privacy disclosure link near the consent checkboxes.
8. **Webhook vs polling for job status updates:** If Service Fusion supports webhooks, prefer them so Castle Admin can keep the lead state current (e.g., mark a lead as `completed` when the technician closes the job).
9. **Initial service area seed data:** Generate a seed list of all cities in San Diego County and Riverside County (use USPS or a similar authoritative source). Also generate the city→zip mapping table that drives the auto-derivation. Pre-populate the `service_area_cities` config in Castle Admin at first run, and ship the city↔zip mapping as reference data the app uses to derive the zip list. John will review and prune the city list from the Settings UI; zip list updates automatically.

---

## 13. Success Metrics

Track in Castle Admin dashboard:

- **Conversion rate:** % of scheduler page visits that result in a submitted booking
- **Volume:** bookings per week, broken down by garage door vs gate and by lead source
- **Approval rate:** % of pending bookings the office approves
- **Time-to-approval:** median minutes from submission to office decision
- **Sync success rate:** % of approved bookings that sync to Service Fusion on first try
- **Dropped leads:** count of leads with `sync_status: sync_failed` that are older than 7 days and haven't been manually synced. *Target: 0.* This is the metric that validates the "never drop a lead" goal.
- **Drop-off by step:** which step loses the most users (informs UX improvements)
- **Service Fusion job source attribution:** confirm `Lead Source` custom field is populated correctly so John can see ROI by channel

---

## Appendix A — Question reference for content review

This is a flat list of every question text and answer option in the scheduler so John can edit copy in one place before build.

**Service type:**
- "What can we help you with?" → Garage Door | Gate

**Garage door — service category:**
- "What kind of service do you need?" → Repairs & Service | Door/Panel Replacement | New Installation | Maintenance / Tune-up

**Garage door — repair sub-questions:**
- "Are you able to open and close your door?" → Yes | No
- "What's the issue?" (multi-select) → Won't open or close | Loud or grinding noise | Off track | Broken spring | Remote or keypad not working | Visible damage | Other

**Garage door — replacement sub-questions:**
- "What type of door are you looking for?" → Something basic and functional | Something nicer with more features | Not sure yet — I'd like recommendations

**Garage door — install sub-questions:**
- "Is this for new construction or replacing an existing door?" → New construction | Replacing existing

**Garage door — universal:**
- "What is the estimated age of your garage door?" → Less than 8 years old | 8 years or older | Don't know
- "Do you have more than one garage door?" → Yes | No

**Gate — service category:**
- "What kind of gate service do you need?" → Repairs & Service | New Installation | Maintenance / Tune-up

**Gate — repair sub-questions:**
- "What type of gate?" → Swing gate | Sliding gate | Pedestrian / walk-through gate
- "What's the issue?" (multi-select) → Gate won't open or close | Motor / operator issue | Remote, keypad, or intercom not working | Visible damage to gate | Hinges or hardware issue | Power / electrical issue | Other

**Gate — install sub-questions:**
- "What type of gate?" → Swing gate | Sliding gate | Driveway gate | Pedestrian gate
- "Material preference?" → Wrought iron | Wood | Aluminum or steel | Not sure — need recommendations
- "Will it need an automatic opener?" → Yes | No | Not sure

**Gate — universal:**
- "How old is the gate?" → Less than 5 years old | 5 years or older | Don't know
- "Do you have more than one gate?" → Yes | No

---

*End of PRD v1. Ready for handoff to Claude Code.*
