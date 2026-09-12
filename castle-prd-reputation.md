# Castle Garage Doors & Gates — Piecework Payroll App
## PRD — Reputation Engine (Big Reputation parity, built in-house)

**Status: PLAN ONLY — nothing in this document is built or authorized yet.**

---

## 1. Purpose

Match what bigreputation.ai sells, inside Castle Admin, on top of what already exists: the post-job CSAT text with the Google review link (Dialpad), the daily Google review sync with job/tech matching, and the Cassie agent framework (Claude, draft-then-approve, style examples, standing instructions).

Six features are in scope. They were chosen in review with the owner on 2026-09-12:

| # | Feature | Decision | Build size |
|---|---|---|---|
| 1 | Follow-up reminder 2 days later | Build (small) | 1–2 days |
| 2 | AI Review Reply Agent | Build | ~2 weeks |
| 3 | Insights & reporting | Build (proposal in §5) | ~1.5 weeks |
| 4 | Automatic Google Business Profile posts from yesterday's jobs, with photos | Build | ~2 weeks |
| 5 | Geo-routing review requests to the nearest Google profile | Build, ready for a second profile | ~1 week |
| 6 | Map Pack rank tracking heat map | Build | ~1 week |

Already done and not touched: review request at job completion, Google review ingestion and matching, CRM integration (Service Fusion mirror).

**Nothing in prior PRDs is changed or removed.** This adds a reputation layer under the existing Reviews section in the admin app.

---

## 2. Two things Big Reputation claims that cannot be copied literally

1. **Photos inside review replies.** Google's reply object is text only (`comment` + `updateTime`). No tool, theirs included, can attach a photo to an owner reply. What they almost certainly do is publish the job photo as a profile post or profile photo and let the reply text point to it. We do the same: feature 4 publishes the photo, and the feature 2 reply can say "we shared photos from this install on our profile" when a linked post exists.
2. **Learning from other companies' replies and posts automatically.** Google's public Places data returns at most 5 reviews per business and does not include owner replies or posts. Harvesting examples from the profiles the owner picks needs either a paid data provider (DataForSEO's review endpoint includes owner replies) or the office pasting 10–20 examples into a style-examples screen. The plan supports both; manual paste is the default.

Also worth knowing: controlled 2026 studies found profile posts do not move Map Pack position. They raise click-through on the profile and keep it looking active. Review count, velocity, and replies remain the ranking levers we can control. This is why the reply agent is phase 1 and posting is phase 2.

---

## 3. Feature 1 — Follow-up reminder (2 days later)

**What today does:** one survey text after job completion. A 5 gets the Google link once. Nothing follows if the customer never replies or never clicks.

**Change:** one reminder, at most, in each of two situations, both 2 days after the original text and inside the existing 8am–7pm PT texting window:

| Situation | Reminder | Template (new, editable in CSAT settings) |
|---|---|---|
| Survey sent, no reply after 2 days | Re-send a shorter survey nudge | `survey_reminder_sms` |
| Rated 5, link sent, link not clicked after 2 days | Re-send the review ask with the same link | `review_reminder_sms` |

Rules: never more than one reminder per survey per situation, respects STOP/opt-out, skipped if the customer replied or clicked in the meantime, skipped for `is_test` surveys. Default delay is 2 days; stored as `reminder_delay_hours` (default 48) in `csat_settings` so it can be tuned.

**Prerequisite (also needed by §5):** click detection per customer. Today every customer gets the same short link, because the code is derived only from the target URL. Change `ensureShortLink` to accept an optional salt (the survey id) so each review request gets its own code. The existing click counter then tells us who clicked.

**Data:** `csat_surveys.survey_reminder_sent_at`, `csat_surveys.review_reminder_sent_at`, `csat_surveys.review_short_code`. No new cron; the existing `csat-send` cron (every 15 minutes) picks these up.

---

## 4. Feature 2 — AI Review Reply Agent

### 4.1 What it does
Every new Google review gets a personalized owner reply, drafted by Claude from the review plus the matched job, approved by a person at first, and posted to Google through the same API connection that already reads reviews.

### 4.2 Pipeline
1. **Trigger.** After each ingest run, select reviews with no reply on Google (`reply_text` is null), not soft-deleted, and no reply row in `draft`/`posted` state. Ingest moves from once a day to every 2 hours (Google quota is 300 requests/minute; we use a handful) so replies go out the same day.
2. **Context.** Review text, star rating, reviewer first name, the matched job (category, description, completion notes, services/items, city and ZIP, tech first name), whether a feature 4 post exists for that job, and the reply date.
3. **Draft.** Claude (the composer model setting, currently Sonnet 5, same as Cassie) writes the reply using: the Reply Charter (voice and hard rules, §4.4), active standing instructions, and the 8–12 most relevant style examples.
4. **Guardrails (deterministic, before a human sees it).** No customer last name, no street address, no prices, no warranty promises, no arguing with a negative review, no mention of a tech by full name, length 40–120 words for 4–5 stars and 60–150 for 1–3 stars, must include the service type and the city or neighborhood when known (that is the "SEO keyword" enrichment Big Reputation advertises), signature block from settings. A failed check sends the draft back with the failure noted, once.
5. **Approval.** New "Replies" tab under Reviews: queue of drafts with the review on the left, the draft on the right, Approve / Edit & Approve / Skip. Edits are saved as style examples (`source='human_edit'`) so the agent learns, same as Cassie.
6. **Post.** `PUT accounts/{a}/locations/{l}/reviews/{r}/reply` with the approved text. The next ingest confirms `reply_text` on Google matches, and the reply row moves to `verified`.
7. **Negative reviews (1–3 stars)** always require a person. The draft acknowledges, does not dispute facts, invites the customer to call the office number, and never names the tech. If the review matches a CSAT survey with an open follow-up case, the case is linked in the queue.

### 4.3 Modes
- **Approve everything** (launch default).
- **Auto-post 4–5 stars.** Can only be switched on after 30 approved replies with fewer than 20% edited. 1–3 stars still queue. Mirrors the Cassie auto-send gate.
- **Off.**

### 4.4 Training and rules
Reuses the Cassie knowledge tables with a new audience value rather than new infrastructure:
- `agent_charter` gains a `channel` column (`email` | `review` | `post`); the Reply Charter is a versioned document editable in the UI (voice, what to thank for, how to handle a 3-star, when to mention photos, signature).
- `agent_instructions` with `channel='review'` for short standing rules ("Never mention pricing", "Always invite gate customers to ask about maintenance plans").
- `agent_style_examples` with `audience='review'`. Seeded three ways: (a) the office pastes examples from the 3–5 profiles the owner picks, (b) Castle's own existing replies on Google are imported on first run (already ingested in `google_reviews.reply_text`), (c) every human edit is captured.
- Optional one-time import of another business's replies through DataForSEO's Google Reviews endpoint if the owner wants more than a handful of examples (a few dollars per profile).

### 4.5 Data
- `review_replies`: id, google_review_id (FK), draft_text, final_text, status (`draft` | `approved` | `posted` | `verified` | `skipped` | `failed`), guardrail_notes jsonb, model, prompt_version, linked_post_id, created_at, approved_by, approved_at, posted_at, error.
- `reputation_settings` (single row): reply_mode, reply_signature, auto_post_min_stars, ingest_interval_hours, and the feature 4 and 6 settings below.
- `google_reviews.reply_source` (`agent` | `manual` | `pre_existing`).

---

## 5. Feature 3 — Insights & reporting (proposal)

What exists: monthly review count and average rating, per-tech leaderboard, CSAT tiles. Proposed additions, in priority order:

| # | Report | What it answers | Data source |
|---|---|---|---|
| 1 | **Review funnel** | Of jobs completed, how many got a survey, replied, gave a 5, got the link, clicked, and posted a review. Per month and per tech. | `csat_surveys`, per-survey short links (§3), `google_reviews` matches. Mostly exists; needs the click fix. |
| 2 | **AI tags on every review** | Sentiment (positive / neutral / negative), themes from a fixed list (punctuality, price and value, communication, quality of work, cleanliness, professionalism, scheduling, warranty and follow-up, emergency response), service mentioned (door repair, opener, spring, gate, new install), employee names mentioned, neighborhood mentioned. | One Claude call per review at ingest, stored on `google_reviews` (`sentiment`, `themes[]`, `mentioned_names[]`, `service_tags[]`, `ai_tagged_at`). Backfill all existing reviews once. |
| 3 | **Themes dashboard** | What customers praise and complain about, by month, with example quotes. Theme count split by star rating. | Item 2. |
| 4 | **Employee mentions** | Which techs customers name, how often, and whether the name matches the job-derived tech (mismatches surface for the admin to fix the credit). | Item 2 plus existing matching. |
| 5 | **Reply performance** | Unreplied count (badge on the tab), median hours to reply, % replied within 24h and 48h, agent vs. manual. | `review_replies`. |
| 6 | **Profile performance** | Daily impressions on Maps and Search, calls, website clicks, direction requests, overlaid with review velocity and post dates. | Google Business Profile Performance API (same OAuth connection; the API must be enabled in the Google Cloud project). Daily cron, `gbp_daily_metrics` table. |
| 7 | **Competitor benchmark** | Rating and review count for the named competitors, weekly, and who outranks us where. | Comes free with the feature 6 rank scans, which return every competitor's rating and review count at each grid point. |
| 8 | **Weekly reputation digest email** | One Monday email: new reviews and average, funnel numbers, unreplied count, posts published, rank change, top theme. | Existing notifications framework (Resend), new notification type `reputation_weekly_digest`. |
| 9 | **Per-tech scorecard** | Reviews, mentions, average stars, CSAT, funnel conversion, side by side. Extends the existing leaderboard. | Items 1, 2, 4. |
| 10 | **Removed reviews** | Reviews Google took down (already soft-deleted on disappearance), counted and listed. | Existing `deleted_at`. |

All of this lives on a new "Insights" tab under Reviews, with the same date and tech filters as the CSAT tab, and a location filter once §6 is live.

---

## 6. Feature 4 — Google Business Profile posts from yesterday's jobs, with photos

### 6.1 Photo source (decides the design)
Service Fusion's API exposes a `pictures` list on each job (`expand=pictures`, documented in the API reference in this repo). The reference does not say what a picture object contains, so a **one-hour live test** against Castle's Service Fusion account is the first task: confirm that URLs come back, whether they expire, and what size they are. If techs are already taking photos in the Service Fusion mobile app, this is the whole photo path. Fallback if the API does not return usable files: a "Job photos" screen in the tech app (upload keyed by Service Fusion job number, stored in Supabase Storage, same pattern as vendor-order attachments).

### 6.2 Photo handling
Google requires a publicly reachable URL, JPG or PNG, 10 KB–5 MB, at least 250×250, best at 1200×900 (4:3). Pipeline: copy from Service Fusion to a public Supabase Storage bucket (`gbp-media`), resize and re-encode, strip EXIF and GPS data, then have Claude screen each photo (product clearly visible; no people, faces, house numbers, license plates, or interiors) and rank the best 1–3. A job with no photo that passes is skipped, not posted without a picture.

### 6.3 Post pipeline
1. Daily cron at 7:30am PT: pick yesterday's completed jobs (mirror `work_completed_at`) in the allowed categories (default: installs, spring and opener replacements, gate work; service calls and warranty excluded, editable), with at least one passing photo, not already posted.
2. Choose up to the daily cap (default 1, weekly cap default 4) preferring job types and cities not posted recently.
3. Claude drafts the post from job category, description, completion notes, services, city or neighborhood, and the Post Charter and style examples. Rules: 80–200 words, plain, no customer name, no street address, no price, service type plus city in the first sentence, ends with a call to action. Button: "Learn more" or "Call now" with a link to the matching page on castlegaragedoors.com (mapping table by category, editable).
4. Approval queue on a new "Posts" tab: preview exactly as Google will show it (photo, text, button), Approve / Edit & Approve / Swap photo / Skip. Auto-publish mode gated the same way as replies.
5. Publish: `POST accounts/{a}/locations/{l}/localPosts` with `topicType: STANDARD`, `media: [{mediaFormat: PHOTO, sourceUrl}]`, `callToAction`. Store the returned post name and state. Standard posts expire after 6 months on Google's side; nothing to do.
6. Link back: `review_replies.linked_post_id` so a reply can mention the shared photos.

### 6.4 Examples from profiles the owner picks
Other businesses' posts are not available through any API. The office pastes 10–20 example posts from the chosen profiles into style examples (`audience='post'`). The Post Charter captures what makes them good (photo first, one job, neighborhood named, short).

### 6.5 Data
- `gbp_posts`: id, sf_job_id, location_id, status (`draft` | `approved` | `published` | `skipped` | `failed`), photo_paths[], chosen_photo_path, draft_text, final_text, cta_type, cta_url, google_post_name, published_at, approved_by, error.
- `job_photos`: sf_job_id, source (`sf` | `tech_upload`), source_ref, storage_path, width, height, screen_result jsonb, screened_at.
- `reputation_settings` additions: posts_mode, daily_cap, weekly_cap, allowed_categories[], cta_map jsonb.

---

## 7. Feature 5 — Geo-routing review requests to the nearest Google profile

### 7.1 Today
One profile, configured by environment variables (`GOOGLE_BUSINESS_ACCOUNT_ID`, `GOOGLE_BUSINESS_LOCATION_ID`) and one review URL in `csat_settings`. `google_reviews.location_id` exists but is never set.

### 7.2 Change
- New `gbp_locations` table: name, google_account_id, google_location_id, place_id, review_url, address, lat, lng, service_zips[], is_default, is_active. Managed on the Integrations page. The current profile becomes row 1 on migration; the environment variables become the fallback only.
- **Routing rule** for each survey, in order: job ZIP in a location's `service_zips` → nearest location by straight-line distance from the ZIP centroid (a static San Diego County ZIP centroid table, ~120 rows, no geocoding API needed) → the default location. The chosen location is stored on `csat_surveys.gbp_location_id` and its review URL is what the 5-star text carries. Admin override per survey in the CSAT tab.
- Ingest loops over every active location and stamps `location_id`. Replies, posts, rank scans, and Insights all key on it. Tech leaderboards are unaffected.
- One Google OAuth connection covers all profiles under the same Google account; a profile under a different Google account needs its own refresh token (column on `gbp_locations`).

Until a second profile exists, everything behaves exactly as today. The value of doing this early is that adding profile 2 becomes a form, not a deploy.

---

## 8. Feature 6 — Map Pack rank tracking heat map

### 8.1 Data provider
Nobody builds this from scratch; the grid data is bought. Recommended: DataForSEO Google Maps SERP API, Live mode, about $0.002 per request, accepts exact latitude/longitude and zoom, $50 minimum deposit. A 9×9 grid (81 points) over the service area for 8 keywords is 648 requests per weekly scan, about $1.30 a week. Alternative: Local Falcon's API at roughly $0.05 per grid point, 25× the cost, with a nicer off-the-shelf UI we would not use.

### 8.2 Scan
- Weekly cron (Monday 5am PT). Settings: grid center (the profile address), grid size (7×7 or 9×9), point spacing (1–1.5 miles), keyword list (defaults: garage door repair, garage door installation, garage door spring repair, garage door opener repair, gate repair, garage door company, emergency garage door repair, garage door service), per location.
- Each result stores our rank at that point (1–20, or none) and the top 20 businesses with their rating and review count. That second part feeds the competitor benchmark in §5.

### 8.3 Display ("Rankings" tab)
- Map with the grid drawn as colored squares (green top 3, yellow 4–10, red 11–20, grey not found), keyword switcher, week-over-week compare. Map rendered with Leaflet and OpenStreetMap tiles (no API key, no cost); Google Maps tiles are an option if a key already exists.
- Numbers: average rank, share of top-3 points, share of points where we appear at all, trend line by keyword.
- **Job-density overlay**: the same grid colored by how many jobs we completed there in the last 90 days (from mirrored job ZIPs). Squares that are busy for us but red on rank are the neighborhoods to push. This is the "neighborhoods where you're not showing up" view Big Reputation sells, and it is where feature 5 pays off once a second profile exists.
- Competitor table per keyword: who holds the top 3 across the most points, with their rating and review count.

### 8.4 Data
`rank_scans` (id, location_id, keyword, run_at, grid jsonb, status) and `rank_scan_points` (scan_id, row, col, lat, lng, our_rank, results jsonb).

---

## 9. Cross-cutting

### 9.1 Admin UI
The Reviews section grows from two tabs to: **CSAT · Google Reviews · Replies · Posts · Insights · Rankings · Settings**. Replies and Posts show a pending-count badge. Settings holds the charters, standing instructions, style examples (per audience), modes, caps, and the keyword list.

### 9.2 Crons (Vercel allows 100 per project; 33 in use today)
| Path | Schedule | Feature |
|---|---|---|
| `ingest-google-reviews` | every 2 hours (was daily) | 2, 3 |
| `review-reply-agent` | 15 minutes after each ingest | 2 |
| `gbp-posts-daily` | 7:30am PT daily | 4 |
| `gbp-performance-daily` | 6am PT daily | 3 |
| `rank-scan-weekly` | Monday 5am PT | 6 |
| `reputation-weekly-digest` | Monday 7am PT | 3 |

### 9.3 Running costs (estimates)
| Item | Monthly |
|---|---|
| Claude calls (replies, tagging, post drafts, photo screening) at Castle's review and job volume | roughly $10–30 |
| DataForSEO weekly scans | roughly $5–6 |
| Supabase Storage for post photos | under $1 |
| Google APIs used | $0 |

### 9.4 One-time setup (owner or office involvement)
1. Confirm the existing Google OAuth token was granted with the `business.manage` scope (it should be; reads use the same scope). If not, re-authorize once.
2. Enable the Business Profile Performance API in the same Google Cloud project.
3. Run the Service Fusion `expand=pictures` test (§6.1).
4. Create a DataForSEO account and fund the $50 minimum.
5. Create the public `gbp-media` storage bucket.
6. Paste example replies and posts from the chosen profiles (§4.4, §6.4).
7. Write or approve the Reply Charter and Post Charter (drafts will be provided).

### 9.5 Risks
- **Review gating.** The Google link goes only to customers who text a 5. Google's April 2026 policy update treats selective solicitation as rating manipulation, with review removal and profile suspension as penalties. Big Reputation's "smart routing" is the same practice. This PRD does not change the current behavior; the decision is called out in §11.
- **Posting on a service-area business.** Proximity ranking is measured from the profile address. Posts and reviews will not make a single address rank across the whole county; the rank grid will show exactly where the ceiling is, which is the data needed to decide on a second profile.
- **Photo privacy.** Only screened product photos are published; no people, house numbers, or plates. Customers are never named in posts.
- **Wrong tech named in a reply.** Replies use the matched job's tech first name only when the match is `auto` or `confirmed`; low-confidence matches produce a reply without a name.

---

## 10. Phasing and effort

| Phase | Weeks | Contents |
|---|---|---|
| 1 | 1–2 | Per-customer short links, 2-day reminders (§3); reply agent in approve mode with charter, instructions, style examples (§4); AI tagging at ingest with backfill (§5 item 2) |
| 2 | 3–4 | Service Fusion photo test, photo pipeline, post drafting and approval, publish (§6); Insights tab items 1, 3, 4, 5, 8 (§5) |
| 3 | 5 | Rank scans and Rankings tab with job-density overlay (§8); Performance API and competitor benchmark (§5 items 6, 7); per-tech scorecard |
| 4 | 6 | Multi-location tables, routing, Integrations UI (§7); auto-post modes unlocked once approval counts are met |

About six weeks of build. Phases 1 and 2 deliver the two headline features. Phase 4 can move earlier if a second profile is imminent.

---

## 11. Open questions for the owner

1. Which 3–5 Google Business Profiles should be used as examples for replies, and which for posts? (They can be the same.)
2. Who approves replies and posts? All admins, or specific people?
3. How fast should a review get a reply? Same day (2-hour ingest, as planned) or faster?
4. Posting cadence: one a day, or 3–4 a week? Which job categories qualify? Where should the button link?
5. Do techs already take job photos in the Service Fusion mobile app? If not, is a photo step in the tech app acceptable?
6. Rank grid: whole county or a radius? Any keywords or competitors to include from the start?
7. Keep sending the Google link only after a 5, or send it to everyone who replies? (§9.5)
8. Is a second Google profile planned, and roughly when and where? This sets the priority of §7.
9. How should replies be signed? For example "— The Castle team" or a person's first name.
