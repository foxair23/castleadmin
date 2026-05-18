# Castle Online Scheduler — Implementation Plan

**Date:** May 2026  
**Status:** Awaiting approval before build starts  

---

## What I found (Phase 1 summary for reference)

### Two separate design systems — important distinction

| | Customer-facing scheduler | Castle Admin Scheduler tab |
|---|---|---|
| **Red** | `#C81E1E` (Castle Red) | `red-600` (#dc2626) — existing admin |
| **Background** | `#F5F5F3` warm off-white | `gray-50` — existing admin |
| **Fonts** | DM Sans (headings) + Source Sans 3 (body) | Geist Sans — existing admin |
| **Border radius** | 8–12px | `rounded-md` / `rounded-lg` — existing admin |

The scheduler app the customer sees must match the **website** (castlegaragedoors.com), not the admin app. The Scheduler tab that John sees inside Castle Admin must match the **existing admin** UI. I'll maintain this split throughout.

### Existing Castle Admin patterns I'll reuse
- `requireAdmin()` auth pattern on all admin API routes  
- Service-role Supabase client for DB writes  
- `{ error: string }` / `{ data }` response shapes  
- `sfGet()` helper in `lib/crm/service-fusion.ts` (I'll add `sfPost()`)  
- Navbar with NavLink pattern — I'll add a "Scheduler" tab entry  

### Service Fusion API — what's confirmed vs. open
- ✅ `GET /customers?search=` — find customer  
- ✅ `POST /customers` — create customer  
- ✅ `POST /jobs` — create job  
- ✅ Custom fields exist on jobs (confirmed via `expand=custom_fields` on GET)  
- ✅ Pictures/documents exist on jobs (confirmed via `expand=pictures,documents` on GET)  
- ❓ **POST body shape for writing a custom field value** — needs browser verification before Chunk 11  
- ❓ **Attachment upload endpoint** — needs browser verification before Chunk 12; fallback is URLs in job notes  
- ❓ Rate limits, idempotency keys, webhooks — not blocking for v1  

---

## Decisions locked in

| Decision | Choice |
|---|---|
| Scheduler app location | New separate repo (`castle-scheduler`), deployed to `schedule.castlegaragedoors.com` on Vercel |
| File storage | Supabase Storage (already integrated) |
| Public API auth | Shared secret: `X-Castle-Widget-Key` header = widget instance API key |
| Roles | Admin-only access to Scheduler tab for now |
| Booking ID format | `CGD-{YYYY}-{00001}` sequential 5-digit |
| Office phone | (800) 576-1397 |
| v1 default sync mode | `manual` |
| Service area seed | All cities in San Diego County + Riverside County (pre-populated, John prunes) |

---

## Repository structure

### New repo: `castle-scheduler`
```
castle-scheduler/
├── app/
│   ├── layout.tsx              # DM Sans + Source Sans 3 fonts, Castle design tokens
│   ├── globals.css             # CSS custom properties matching website design system
│   ├── page.tsx                # Entry — loads config, renders flow
│   └── confirmation/
│       └── page.tsx            # Step 11 — success screen
├── components/
│   ├── flow/
│   │   ├── StepServiceType.tsx     # Step 1
│   │   ├── StepCategory.tsx        # Steps 2A / 2B
│   │   ├── StepDiagnostic.tsx      # Steps 3A / 3B
│   │   ├── StepUniversal.tsx       # Steps 4A / 4B
│   │   ├── StepContact.tsx         # Step 5
│   │   ├── StepAddress.tsx         # Step 6
│   │   ├── StepSchedule.tsx        # Step 7
│   │   ├── StepDetails.tsx         # Step 8
│   │   ├── StepIncentive.tsx       # Step 9 banner
│   │   └── StepReview.tsx          # Step 10
│   ├── ui/
│   │   ├── ProgressBar.tsx
│   │   ├── ServiceCard.tsx         # Large tappable card (Step 1, 2A, 2B)
│   │   ├── MultiSelect.tsx         # Checkbox group for issue selection
│   │   ├── PhoneInput.tsx          # US phone formatting
│   │   ├── DatePicker.tsx          # Horizontal date strip
│   │   ├── TimeWindow.tsx          # AM/PM window selector
│   │   ├── FileUpload.tsx          # Drag-drop + preview
│   │   └── BackButton.tsx
│   └── FlowShell.tsx               # Wraps all steps: progress bar, back btn, step routing
├── lib/
│   ├── api.ts                  # Typed wrappers for Castle Admin API calls
│   ├── storage.ts              # localStorage persistence helpers
│   ├── validation.ts           # Phone, email, zip validators
│   └── types.ts                # Shared types (FlowState, BookingPayload, etc.)
├── public/
│   └── logo.png
├── next.config.ts
├── tailwind.config.ts          # Custom Castle website tokens
└── package.json
```

### Castle Admin additions (existing repo)
```
castleadmin/
├── app/
│   ├── admin/
│   │   └── scheduler/
│   │       ├── layout.tsx              # Scheduler sub-layout
│   │       ├── page.tsx                # Dashboard (redirect or default view)
│   │       ├── leads/
│   │       │   ├── page.tsx            # Leads inbox
│   │       │   └── [id]/
│   │       │       └── page.tsx        # Lead detail
│   │       ├── embed/
│   │       │   └── page.tsx            # Widget instances + embed snippets
│   │       └── settings/
│   │           └── page.tsx            # All scheduler settings
│   └── api/
│       ├── scheduler/
│       │   ├── config/route.ts         # GET — public, no session required
│       │   ├── bookings/route.ts       # POST — widget key auth
│       │   └── uploads/route.ts        # POST — widget key auth, Supabase Storage
│       └── admin/
│           └── scheduler/
│               ├── leads/
│               │   ├── route.ts        # GET list, filters
│               │   ├── export/route.ts # GET CSV
│               │   └── [id]/
│               │       ├── route.ts    # GET detail, PATCH approve/reject/edit
│               │       └── sync/route.ts # POST trigger SF sync
│               ├── settings/route.ts   # GET + PATCH
│               ├── widget-instances/
│               │   ├── route.ts        # GET list, POST create
│               │   └── [id]/route.ts   # PATCH, DELETE
│               └── stats/route.ts      # GET dashboard metrics
├── components/
│   └── Navbar.tsx              # Add "Scheduler" NavLink for admin
├── lib/
│   └── crm/
│       └── service-fusion.ts   # Add sfPost(), createCustomer(), createJob(), uploadAttachment()
└── supabase/
    └── migrations/
        └── 012_scheduler.sql   # All new scheduler tables
```

---

## Database schema (migration 012)

```sql
-- ── Booking ID counter ────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS scheduler_lead_seq START 1;

-- ── Settings (key-value store) ────────────────────────────────────────────
CREATE TABLE public.scheduler_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES public.profiles(id)
);

-- ── Settings audit log ────────────────────────────────────────────────────
CREATE TABLE public.scheduler_settings_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES public.profiles(id),
  key         text NOT NULL,
  old_value   jsonb,
  new_value   jsonb NOT NULL
);

-- ── Widget instances ──────────────────────────────────────────────────────
CREATE TABLE public.scheduler_widget_instances (
  id           text PRIMARY KEY,              -- e.g. 'main_site'
  display_name text NOT NULL,
  lead_source  text NOT NULL,
  api_key      text NOT NULL,                 -- shared secret for X-Castle-Widget-Key
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES public.profiles(id)
);

-- ── Service area: city list (editable) ───────────────────────────────────
CREATE TABLE public.scheduler_service_area_cities (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city      text NOT NULL,
  state     text NOT NULL DEFAULT 'CA',
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (city, state)
);

-- ── City → zip reference mapping (read-only, derived) ────────────────────
CREATE TABLE public.scheduler_city_zip_map (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city  text NOT NULL,
  state text NOT NULL DEFAULT 'CA',
  zip   text NOT NULL,
  UNIQUE (city, state, zip)
);

-- ── Leads (source of truth) ───────────────────────────────────────────────
CREATE TABLE public.scheduler_leads (
  -- Identity
  id                text PRIMARY KEY,         -- CGD-2026-00001
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Workflow status (office)
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),

  -- Sync status (Service Fusion handoff)
  sync_status       text NOT NULL DEFAULT 'not_attempted'
                    CHECK (sync_status IN ('not_attempted','in_progress','synced','sync_failed','manually_synced')),

  -- Attribution
  lead_source       text NOT NULL DEFAULT 'website',
  widget_instance_id text REFERENCES public.scheduler_widget_instances(id),

  -- Service details
  service_type      text NOT NULL CHECK (service_type IN ('garage_door','gate')),
  service_category  text NOT NULL,
  diagnostic_answers jsonb NOT NULL DEFAULT '{}',

  -- Customer
  customer_first_name  text NOT NULL,
  customer_last_name   text NOT NULL,
  customer_phone       text NOT NULL,
  customer_email       text NOT NULL,
  customer_sms_appointment_consent boolean NOT NULL DEFAULT false,
  customer_sms_marketing_consent   boolean NOT NULL DEFAULT false,

  -- Address
  address_line1      text NOT NULL,
  address_line2      text,
  address_city       text NOT NULL,
  address_state      text NOT NULL DEFAULT 'CA',
  address_zip        text NOT NULL,
  address_is_owner   boolean NOT NULL DEFAULT true,
  address_in_service_area boolean,           -- null = not yet checked

  -- Appointment
  appointment_date         date NOT NULL,
  appointment_window_start text NOT NULL,    -- '08:00'
  appointment_window_end   text NOT NULL,    -- '12:00'
  appointment_timezone     text NOT NULL DEFAULT 'America/Los_Angeles',

  -- Content
  description       text,
  incentive_applied text,

  -- Service Fusion
  service_fusion_customer_id text,
  service_fusion_job_id      text,
  sync_attempts              jsonb NOT NULL DEFAULT '[]',
  synced_at                  timestamptz,

  -- Approval audit trail
  auto_approved  boolean NOT NULL DEFAULT false,
  approved_by    uuid REFERENCES public.profiles(id),
  approved_at    timestamptz,
  rejected_reason text,

  -- Internal
  notes_internal text NOT NULL DEFAULT ''
);

CREATE INDEX idx_sched_leads_status      ON public.scheduler_leads(status);
CREATE INDEX idx_sched_leads_sync_status ON public.scheduler_leads(sync_status);
CREATE INDEX idx_sched_leads_created_at  ON public.scheduler_leads(created_at DESC);
CREATE INDEX idx_sched_leads_phone       ON public.scheduler_leads(customer_phone);
CREATE INDEX idx_sched_leads_email       ON public.scheduler_leads(customer_email);

-- ── Lead attachments ──────────────────────────────────────────────────────
CREATE TABLE public.scheduler_lead_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     text NOT NULL REFERENCES public.scheduler_leads(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  storage_path text NOT NULL,   -- Supabase Storage path
  mime_type   text NOT NULL,
  size_bytes  int NOT NULL,
  service_fusion_attachment_id text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Public scheduler tables: no direct client access (all via API routes using service role)
ALTER TABLE public.scheduler_leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_lead_attachments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_settings_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_widget_instances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_service_area_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_city_zip_map      ENABLE ROW LEVEL SECURITY;

-- All scheduler tables: admin read/write only (service role bypasses RLS for API routes)
CREATE POLICY "admin_all_scheduler_leads"      ON public.scheduler_leads      FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_scheduler_attachments" ON public.scheduler_lead_attachments FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_scheduler_settings"   ON public.scheduler_settings   FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_scheduler_settings_log" ON public.scheduler_settings_log FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_widget_instances"     ON public.scheduler_widget_instances FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_service_area_cities"  ON public.scheduler_service_area_cities FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_city_zip_map"         ON public.scheduler_city_zip_map FOR ALL USING (public.is_admin());

-- Explicit grants (required per Supabase Oct 2026 change)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_leads             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_lead_attachments  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_settings          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_settings_log      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_widget_instances  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_service_area_cities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_city_zip_map      TO authenticated;
GRANT ALL ON public.scheduler_leads             TO service_role;
GRANT ALL ON public.scheduler_lead_attachments  TO service_role;
GRANT ALL ON public.scheduler_settings          TO service_role;
GRANT ALL ON public.scheduler_settings_log      TO service_role;
GRANT ALL ON public.scheduler_widget_instances  TO service_role;
GRANT ALL ON public.scheduler_service_area_cities TO service_role;
GRANT ALL ON public.scheduler_city_zip_map      TO service_role;

-- ── Default settings seed ─────────────────────────────────────────────────
INSERT INTO public.scheduler_settings (key, value) VALUES
  ('sync_mode',              '"manual"'),
  ('auto_sync_area_only',    'true'),
  ('auto_sync_skip_dupes',   'true'),
  ('booking_horizon_days',   '14'),
  ('available_days',         '[1,2,3,4,5,6]'),  -- Mon–Sat (0=Sun)
  ('time_windows',           '[{"start":"08:00","end":"12:00","label":"8 AM – 12 PM"},{"start":"12:00","end":"16:00","label":"12 PM – 4 PM"}]'),
  ('incentive_copy',         '"$50 off your first service"'),
  ('incentive_active',       'true'),
  ('office_notification_email', '"office@castlegaragedoors.com"'),
  ('max_upload_files',       '5'),
  ('max_upload_size_mb',     '25'),
  ('file_retention_days',    '30'),
  ('tcpa_copy',              '"By checking this box, you consent to receive text messages about your appointment from Castle Garage Doors & Gates. Message and data rates may apply. Reply STOP to opt out."'),
  ('marketing_sms_copy',     '"I''d like to receive promotions and tips by SMS."'),
  ('office_phone',           '"(800) 576-1397"');
```

---

## API endpoints

### Public (no user session — widget key auth via `X-Castle-Widget-Key` header)

| Method | Path | Description |
|---|---|---|
| GET | `/api/scheduler/config` | Returns time windows, service area zips/cities, incentive copy, available days, booking horizon, office phone. No auth required (public config). |
| POST | `/api/scheduler/bookings` | Creates a lead. Requires valid `X-Castle-Widget-Key` matching an active widget instance. Returns `{ id, confirmation_number, appointment }`. |
| POST | `/api/scheduler/uploads` | Uploads a file to Supabase Storage. Returns `{ storage_path, public_url }`. Same widget key auth. |

### Admin (requireAdmin() pattern)

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/scheduler/leads` | List leads with filters: status, sync_status, date range, service type, lead source, in_service_area. Search by name/phone/email/address/confirmation#. Pagination. |
| GET | `/api/admin/scheduler/leads/export` | CSV export of filtered leads. |
| GET | `/api/admin/scheduler/leads/[id]` | Full lead detail including attachments and sync_attempts array. |
| PATCH | `/api/admin/scheduler/leads/[id]` | Approve / reject / edit notes / mark-manually-synced. Body determines action. |
| POST | `/api/admin/scheduler/leads/[id]/sync` | Trigger SF sync for one lead. |
| GET | `/api/admin/scheduler/settings` | All settings as key→value map. |
| PATCH | `/api/admin/scheduler/settings` | Update one or more settings. Writes to audit log. |
| GET | `/api/admin/scheduler/widget-instances` | List all widget instances with stats. |
| POST | `/api/admin/scheduler/widget-instances` | Create new instance. Auto-generates API key. |
| PATCH | `/api/admin/scheduler/widget-instances/[id]` | Update name/lead_source/is_active. |
| GET | `/api/admin/scheduler/stats` | Dashboard metrics: pending count, sync failures, bookings this week/month, conversion trend, lead source breakdown. |

---

## Order of work (15 shippable chunks)

Each chunk ends with: code committed and pushed, you can see it working, then we move on. No batching.

### Chunk 1 — Database schema + Castle Admin data layer
**What:** Migration 012 (all new scheduler tables), seed default settings, seed San Diego + Riverside city list and city→zip mapping, add explicit grants.  
**Deliverable:** Migration SQL file ready to run in Supabase. No visible UI yet.  
**Effort:** 0.5 day  
**Risk:** City/zip seed data accuracy. Mitigation: use USPS ZCTA data for California.

### Chunk 2 — POST /api/scheduler/bookings (no SF yet)
**What:** The core booking write endpoint. Validates widget key, validates payload, runs service area check, writes lead to DB with `status: pending` / `sync_status: not_attempted`, generates confirmation number, returns it.  
**Deliverable:** Can POST to the endpoint with curl/Postman and see a lead appear in Supabase.  
**Effort:** 0.5 day

### Chunk 3 — GET /api/scheduler/config
**What:** Public config endpoint. Reads settings from DB, derives zip list from active cities, returns everything the scheduler app needs to render.  
**Deliverable:** GET the endpoint, get back time windows, available days, incentive copy, service area data.  
**Effort:** 0.25 day

### Chunk 4 — Scheduler frontend: Garage Door flow (end to end)
**What:** New `castle-scheduler` repo. Tailwind configured with Castle website design tokens. Steps 1→2A→3A→4A→5→6→7→8→9→10→11 for the Garage Door path. Loads config from Castle Admin. Form state persisted in localStorage. Out-of-area warning. Service area check. Submits to POST /api/scheduler/bookings. Shows confirmation screen.  
**Deliverable:** You can open `localhost:3001` and complete a garage door booking end to end.  
**Effort:** 3 days  
**Note:** Mobile-first layout, 44px tap targets, keyboard nav, WCAG 2.1 AA throughout.

### Chunk 5 — Scheduler frontend: Gate flow
**What:** Add Steps 2B→3B→4B to the existing flow shell.  
**Deliverable:** Gate path works end to end alongside Garage Door path.  
**Effort:** 1 day

### Chunk 6 — File upload
**What:** File upload UI in Step 8 + POST /api/scheduler/uploads (Supabase Storage bucket `scheduler-uploads`, path `{lead_id}/{filename}`). Max 5 files / 25 MB. Non-blocking on booking submit if upload fails.  
**Deliverable:** Can attach a photo in Step 8 and see it stored in Supabase Storage.  
**Effort:** 0.5 day

### Chunk 7 — Castle Admin: Leads inbox
**What:** `/admin/scheduler/leads` — list view with all columns, filters, search, pagination, bulk approve/reject, CSV export. Lead detail page with full submission data, sync history, notes field, approve/reject/edit buttons.  
**Deliverable:** After submitting a booking in the scheduler, John can see it in Castle Admin with all details.  
**Effort:** 2 days

### Chunk 8 — Castle Admin: Settings
**What:** `/admin/scheduler/settings` — all config sections: Availability, Service area (city list editor + read-only zip list), Incentive, Notifications, Uploads, Consent copy, SF connection status. Every change logged.  
**Deliverable:** John can change time windows in Settings and the scheduler immediately reflects the new windows.  
**Effort:** 1.5 days

### Chunk 9 — Castle Admin: Widget Instances + Embed snippets
**What:** `/admin/scheduler/embed` — create/manage instances, copy embed snippet, preview link, per-instance stats, disable toggle.  
**Deliverable:** John can create a widget instance and get an iframe snippet to paste into the website.  
**Effort:** 1 day

### Chunk 10 — Castle Admin: Dashboard
**What:** `/admin/scheduler` — pending count, sync failure count, bookings this week/month, lead source breakdown, recent activity. Uses same Card + chart patterns as existing DashboardClient.  
**Deliverable:** Landing page of Scheduler tab shows real numbers.  
**Effort:** 1 day

### Chunk 11 — Service Fusion sync on approval
**What:** When admin approves a lead (or auto-approve fires), the sync runs: find/create SF customer, create SF job with service type, window, address, notes, lead source custom field. Store returned IDs. Update sync_status.  
**Prerequisite:** Verify SF custom field POST body shape in the docs portal before building this chunk.  
**Deliverable:** Approve a test lead → job appears in Service Fusion.  
**Effort:** 1.5 days

### Chunk 12 — Service Fusion attachment upload
**What:** After job is created in SF, upload stored files to the SF job. Fallback: if SF attachment API not supported, append public Supabase Storage URLs to the job description.  
**Prerequisite:** Verify SF attachment endpoint in docs portal.  
**Effort:** 0.5 day

### Chunk 13 — Retry logic + sync_failed handling
**What:** Exponential backoff retry (3 attempts, 5 min / 30 min / 4 hour intervals). Background retry can run as a Vercel cron (add to vercel.json). Retry button in Lead detail. Manual "mark as synced" button with required note.  
**Deliverable:** Kill SF API mid-sync → lead shows sync_failed → retry button works → synced.  
**Effort:** 1 day

### Chunk 14 — Email notification to office
**What:** On new booking submission, send email to the configured office email. Content: confirmation number, customer name, service type, appointment window, address. Use a simple fetch to a transactional email provider.  
**Open question:** Which email provider? Recommend **Resend** (free tier, simple API, no SMTP). I'll ask before building this chunk.  
**Effort:** 0.5 day

### Chunk 15 — Embed snippet on castlegaragedoors.com
**What:** Add the iframe snippet to the castlegaragedoors.com `Book Online` CTA. Add postMessage height-resize logic in the scheduler so the iframe auto-sizes.  
**Effort:** 0.25 day

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SF custom field POST body unknown | Medium | High | Verify in SF docs portal before Chunk 11. Fallback: include lead source in job description text. |
| SF attachment upload not available via API | Medium | Medium | Fallback ready: append Supabase Storage public URLs to job notes. |
| Supabase Storage 25 MB limit | Low | Medium | Default limit is 50 MB per file on free plan — well within our 25 MB cap. |
| iframe auto-height on mobile | Medium | Low | postMessage resize observer pattern is well established. Tested on iOS/Android. |
| City/zip seed data accuracy | Low | Low | USPS ZCTA reference data for CA is reliable. John can prune cities from Settings UI. |
| SF rate limits hit during approval batch | Low | Low | Sync runs one lead at a time; retry logic handles 429s. |
| Spam bookings | Medium | Medium | Honeypot field + IP rate limit (5/hour). Cloudflare Turnstile on standby for v1.1 if needed. |

---

## Effort summary

| Phase | Chunks | Effort |
|---|---|---|
| Foundation | 1–3 (DB + APIs) | 1.25 days |
| Scheduler frontend | 4–6 (Garage Door, Gate, uploads) | 4.5 days |
| Admin tab | 7–10 (Leads, Settings, Embed, Dashboard) | 5.5 days |
| SF sync | 11–13 (sync, attachments, retry) | 3 days |
| Finishing | 14–15 (email, embed) | 0.75 days |
| **Total** | | **~15 days of build time** |

At 3–4 sessions per week this lands inside the PRD's 4–6 week target.

---

## Open questions before any code is written

1. ✅ Repo strategy — Option 1 (new repo)
2. ✅ File storage — Supabase Storage
3. ✅ Public API auth — shared widget key
4. ✅ Roles — admin-only for now
5. ✅ Design system — website tokens for scheduler frontend, Castle Admin tokens for admin tab
6. ✅ Booking ID — CGD-{YYYY}-{00001}
7. ✅ Office phone — (800) 576-1397
8. **Email provider** — I recommend Resend. Confirm before Chunk 14.
9. **SF docs verification** — Need browser check on attachment endpoint and custom field POST shape before Chunks 11–12. You or I can do this when we get there.
10. **Vercel project for `castle-scheduler`** — You'll need to create the Vercel project and point `schedule.castlegaragedoors.com` to it. I'll flag when we're ready.

---

*Ready to build on your approval. No code has been written yet.*
