# Castle Garage Doors & Gates — Piecework Payroll App
## PRD — Reputation Engine (Big Reputation parity, built in-house)

**Status: Phase 1 MERGED (migration 135 applied); Phase 2 BUILT on branch `claude/big-reputation-analysis-wuuc8w` (2026-09-13); Phases 3–4 not started.**
Phase 1 covers §3 (reminders, per-customer review links), §4 (reply agent, autopilot switches, backlog, humanized send queue), §5 item 2 (AI tags) and the Settings sub-tab in §9.1.
Phase 2 covers §6 (job photos from Service Fusion, photo scoring and before/after pairing, post drafting with guardrails, the Posts sub-tab, posts autopilot off by default, publishing through the send queue) and §5 items 1, 3, 4, 5, 8, 9 and 11 (the Insights sub-tab and the Monday digest email). Owner steps before it runs: apply `supabase/migrations/136_reputation_posts.sql` in the Supabase SQL editor, then use "Check a job's photos" on the Posts sub-tab with a recent job number to confirm Service Fusion returns picture files. Button links on posts point at castlegarage.com (the domain moved; §6.4 below says castlegaragedoors.com).
Revision 2, 2026-09-12: incorporates owner feedback on autopilot switches, historical reviews, humanized send timing, tab layout, photo relevance, configurable and live rank queries, and no tech names.

---

## 1. Purpose

Match what bigreputation.ai sells, inside Castle Admin, on top of what already exists: the post-job CSAT text with the Google review link (Dialpad), the daily Google review sync with job/tech matching, and the Cassie agent framework (Claude, draft-then-approve, style examples, standing instructions).

| # | Feature | Decision | Build size |
|---|---|---|---|
| 1 | Follow-up reminder 2 days later | Build (small) | 1–2 days |
| 2 | AI Review Reply Agent, with autopilot switches, historical backlog, humanized send timing | Build | ~2.5 weeks |
| 3 | Insights & reporting | Build (proposal in §5) | ~1.5 weeks |
| 4 | Automatic Google Business Profile posts from yesterday's jobs, with relevance-scored photos | Build | ~2 weeks |
| 5 | Geo-routing review requests to the nearest Google profile | Build, ready for a second profile | ~1 week |
| 6 | Map Pack rank tracking: monitored list plus live keyword-at-location query | Build | ~1.5 weeks |

Already done and not touched: review request at job completion, Google review ingestion and matching, CRM integration (Service Fusion mirror).

**Nothing in prior PRDs is changed or removed.** Everything here lives under the existing Reviews main tab (§9.1).

**Standing rule for the whole project: no technician is ever named in a review request, a reply, or a post.** Tech attribution stays internal (leaderboards, scorecards). The agent never sees tech names in its drafting context.

---

## 2. Two things Big Reputation claims that cannot be copied literally

1. **Photos inside review replies.** Google's reply object is text only (`comment` + `updateTime`). No tool can attach a photo to an owner reply. They almost certainly publish the job photo as a profile post and let the reply text point to it. We do the same: feature 4 publishes the photo, and the feature 2 reply can say "we shared photos from this install on our profile" when a linked post exists.
2. **Learning from other companies' replies and posts automatically.** Google's public Places data returns at most 5 reviews per business and does not include owner replies or posts. Examples from the profiles the owner picks are pasted into a style-examples screen by the office (default), or imported once through a paid data provider that includes owner replies (DataForSEO; a few dollars per profile).

Also: controlled 2026 studies found profile posts do not move Map Pack position. They raise click-through and keep the profile looking active. Review count, velocity, and replies remain the ranking levers we control, which is why the reply agent is phase 1 and posting is phase 2.

---

## 3. Feature 1 — Follow-up reminder (2 days later)

**What today does:** one survey text after job completion. A 5 gets the Google link once. Nothing follows if the customer never replies or never clicks.

**Change:** one reminder, at most, in each of two situations, both 2 days after the original text, inside the existing 8am–7pm PT texting window, at a humanized time (§4.5):

| Situation | Reminder | Template (new, editable in CSAT settings) |
|---|---|---|
| Survey sent, no reply after 2 days | Shorter survey nudge | `survey_reminder_sms` |
| Rated 5, link sent, link not clicked after 2 days | Review ask again with the same link | `review_reminder_sms` |

Rules: never more than one reminder per survey per situation, respects STOP/opt-out, skipped if the customer replied or clicked in the meantime, skipped for `is_test` surveys. `reminder_delay_hours` (default 48) in `csat_settings`.

**Prerequisite (also needed by §5):** per-customer click detection. Today every customer gets the same short link because the code is derived only from the target URL. `ensureShortLink` gains an optional salt (the survey id) so each review request gets its own code; the existing click counter then tells us who clicked.

**Data:** `csat_surveys.survey_reminder_sent_at`, `review_reminder_sent_at`, `review_short_code`. Sends go through the dispatcher (§4.5), not a new cron.

---

## 4. Feature 2 — AI Review Reply Agent

### 4.1 What it does
Every Google review, new or historical, gets a reply drafted by Claude from the review plus the matched job. Two autopilot switches decide whether drafts go out on their own or wait for a person. Sends are spread out at natural-looking times so the profile reads like a person answering, not a batch job.

### 4.2 Drafting (always on)
1. **Sync.** Google review ingest moves from once a day to **every 30 minutes** (Google quota is 300 requests/minute; a run uses a handful). Drafting runs at the end of every sync.
2. **Select.** Reviews with no reply on Google, not soft-deleted, and no reply row already in `draft`/`scheduled`/`posted`.
3. **Context.** Review text, star rating, reviewer first name, the matched job (category, description, completion notes, services/items, city and ZIP), whether a feature 4 post exists for that job, review age. **Tech names are excluded from the context.**
4. **Draft.** Claude (the composer model setting, currently Sonnet 5, same as Cassie) writes the reply from the Reply Charter (voice and hard rules), active standing instructions, and the 8–12 most relevant style examples, with separate example pools for 4–5 star and 1–3 star replies.
5. **Guardrails (deterministic, before anything else).** No customer last name, no street address, no prices, no warranty promises, no arguing with a negative review, **no tech name or nickname** (checked against the full tech roster), length 40–120 words for 4–5 stars and 60–150 for 1–3 stars, must include the service type and the city or neighborhood when known (the "SEO keyword" enrichment Big Reputation advertises), signature from settings (decided: "Castle team"). A failed check redrafts once with the failure noted; a second failure lands in the queue flagged.
6. **Old reviews with no matched job** get a shorter, generic-but-specific reply (service type inferred from the review text only, no job facts).

### 4.3 Two autopilot switches
| Switch | Covers | Default at launch |
|---|---|---|
| **Autopilot: 4–5 star replies** | Drafts for 4 and 5 star reviews are scheduled and sent without approval | Off |
| **Autopilot: 1–3 star replies** | Drafts for 1, 2, and 3 star reviews are scheduled and sent without approval | Off |

With a switch off, drafts in that band wait in the queue for Approve / Edit & Approve / Skip. With it on, drafts skip the queue and go to the dispatcher (§4.5). Each switch shows its band's recent numbers next to it (drafts approved unedited vs. edited in the last 30 and 90 days) so the owner can judge readiness, but nothing locks the switch. The 1–3 star band is expected to stay off longer because there are fewer examples to train on; every edit in that band is captured as a style example for that band.

A third control, **Pause all sends**, stops the dispatcher without touching drafts or the switches.

### 4.4 Historical reviews
- The Google Reviews tab gets a **"Draft replies for old reviews"** button. It opens a small dialog: date range (default: everything unreplied), star bands to include, and a daily send cap for the backlog (default 3 per day). It then drafts every matching unreplied review and marks them `backlog`.
- Backlog drafts follow the same switches: with autopilot on for their band they schedule automatically, otherwise they queue. Either way the dispatcher spreads backlog sends across days at the backlog cap, interleaved with new-review replies, oldest first.
- A reply on a 3-year-old review is normal on Google; a hundred of them in an afternoon is not. The cap and the stagger exist for that reason.
- Castle's existing replies already on Google are imported on first run as style examples (`source='pre_existing'`) and are never re-replied.

### 4.5 Humanized send timing (the dispatcher)
One outbound scheduler for review replies, profile posts, and the §3 reminders. It never sends at the moment something is approved; it assigns a send time and a per-minute cron (`reputation-dispatch`, same pattern as the existing per-minute `send-notifications` and `cassie-poll` crons) sends whatever is due.

Rules, all editable in Settings:
- **Working window.** Default Monday–Friday 7:40am–6:20pm PT, Saturday 8:30am–2:10pm PT, Sunday off. Anything approved outside the window waits for the next open window.
- **Reply delay.** A new review's reply is scheduled 1–6 hours after the review is seen (random, uniform), then pushed to the next open window if needed. Nobody answers in 90 seconds; nobody waits a week.
- **Odd minutes.** The scheduled minute is never :00, :15, :30, or :45 and avoids multiples of 5 nine times out of ten. Seconds are randomized too, so send timestamps look like 9:02:41 and 10:28:17.
- **Spacing.** Consecutive sends of any kind are at least 20 minutes apart and usually more (random 20–90 minutes), so five approvals in a row leave the building over an afternoon, not a minute.
- **Daily caps.** New-review replies default 8 per day, backlog replies default 3 per day, posts default 1 per day. Caps are per profile once §7 exists.
- **Natural gaps.** A random 25% of window hours are skipped entirely, so the pattern is not one send per hour like clockwork.
- **Priority.** New 1–3 star replies first (when their switch is on), then new 4–5 star, then reminders, then posts, then backlog.

Every send records the planned time, the actual time, and the reason if it was pushed (window, spacing, cap), visible in the queue.

### 4.6 Post and verify
`PUT accounts/{a}/locations/{l}/reviews/{r}/reply` with the final text. The next sync confirms `reply_text` on Google matches and moves the row to `verified`. A Google-side failure retries twice with the same stagger rules, then flags the row.

### 4.7 Training and rules
Reuses the Cassie knowledge tables with a new channel rather than new infrastructure:
- `agent_charter` gains a `channel` column (`email` | `review` | `post`); the Reply Charter is a versioned document editable in the UI (voice, what to thank for, how to handle a 3-star, when to mention photos, signature, the no-names rule).
- `agent_instructions` with `channel='review'` for short standing rules ("Never mention pricing", "Always invite gate customers to ask about maintenance plans").
- `agent_style_examples` with `audience='review_positive'` and `audience='review_negative'`. Seeded three ways: (a) the office pastes examples from the 3–5 profiles the owner picks, (b) Castle's own existing replies are imported on first run, (c) every human edit is captured into its band.
- Optional one-time import of another business's replies through DataForSEO's Google Reviews endpoint if the owner wants more examples than a handful.

### 4.8 Data
- `review_replies`: id, google_review_id (FK), band (`positive` | `negative`), origin (`new` | `backlog`), draft_text, final_text, status (`draft` | `approved` | `scheduled` | `posted` | `verified` | `skipped` | `failed`), guardrail_notes jsonb, model, prompt_version, linked_post_id, created_at, approved_by, approved_at, scheduled_for, sent_at, push_reasons text[], error.
- `outbound_queue` (the dispatcher): id, kind (`review_reply` | `gbp_post` | `csat_reminder`), ref_id, location_id, priority, earliest_at, scheduled_for, sent_at, status, attempts, push_reasons text[].
- `reputation_settings` (single row): autopilot_positive, autopilot_negative, sends_paused, reply_signature, reply_delay_min_hours, reply_delay_max_hours, working_window jsonb, min_gap_minutes, max_gap_minutes, skip_hour_ratio, cap_new_replies, cap_backlog_replies, cap_posts, ingest_interval_minutes, plus the feature 4 and 6 settings below.
- `google_reviews.reply_source` (`agent` | `manual` | `pre_existing`).

---

## 5. Feature 3 — Insights & reporting (proposal)

What exists: monthly review count and average rating, per-tech leaderboard, CSAT tiles. Proposed additions, in priority order:

| # | Report | What it answers | Data source |
|---|---|---|---|
| 1 | **Review funnel** | Of jobs completed, how many got a survey, replied, gave a 5, got the link, clicked, and posted a review. Per month and per tech (internal only). | `csat_surveys`, per-survey short links (§3), `google_reviews` matches. |
| 2 | **AI tags on every review** | Sentiment; themes from a fixed list (punctuality, price and value, communication, quality of work, cleanliness, professionalism, scheduling, warranty and follow-up, emergency response); service mentioned; employee names mentioned; neighborhood mentioned. | One Claude call per review at sync, stored on `google_reviews`. Backfill all existing reviews once. |
| 3 | **Themes dashboard** | What customers praise and complain about, by month, with example quotes, split by star rating. | Item 2. |
| 4 | **Employee mentions** | Which techs customers name on their own, and whether it matches the job-derived tech. Internal attribution only; never echoed in replies. | Item 2 plus existing matching. |
| 5 | **Reply performance** | Unreplied count (badge), median hours to reply, share replied within 24h and 48h, agent vs. manual, backlog burn-down. | `review_replies`, `outbound_queue`. |
| 6 | **Profile performance** | Daily impressions on Maps and Search, calls, website clicks, direction requests, overlaid with review velocity and post dates. | Google Business Profile Performance API (same OAuth connection; must be enabled once in the Google Cloud project). Daily cron, `gbp_daily_metrics`. |
| 7 | **Competitor benchmark** | Rating and review count for named competitors, weekly, and who outranks us where. | Free with the §8 rank scans. |
| 8 | **Photo quality by tech** | Average relevance score, share of usable photos, most common rejection reasons, per tech per month. Directly supports the effort to get techs taking better photos. | §6.2 scores. |
| 9 | **Weekly reputation digest email** | Monday email: new reviews and average, funnel, unreplied count, posts published, rank change, top theme, photo-quality leaders. | Existing notifications framework (Resend), new type `reputation_weekly_digest`. |
| 10 | **Per-tech scorecard** | Reviews, mentions, average stars, CSAT, funnel conversion, photo quality, side by side. Extends the leaderboard. | Items 1, 2, 4, 8. |
| 11 | **Removed reviews** | Reviews Google took down, counted and listed. | Existing `deleted_at`. |
| 12 | **Neighborhood scorecard** | For each named area: rank, jobs, reviews, funnel, reply rate, area page, top competitor, with movement rules that say what to do next. | §8.5; shown on the Rankings sub-tab, summarized in the digest. |

All of this lives on the Insights sub-tab, with the same date and tech filters as the CSAT tab, and a location filter once §7 is live.

---

## 6. Feature 4 — Google Business Profile posts from yesterday's jobs, with photos

### 6.1 Photo source (decides the design)
Service Fusion's API exposes a `pictures` list on each job (`expand=pictures`, documented in the API reference in this repo). The reference does not say what a picture object contains, so a **one-hour live test** against Castle's Service Fusion account is the first task: confirm URLs come back, whether they expire, and their size. Techs already take photos in the Service Fusion mobile app (confirmed by the owner), so this is the intended photo path. Fallback only if the API does not return usable files: a "Job photos" screen in the tech app (upload keyed by Service Fusion job number, Supabase Storage, same pattern as vendor-order attachments).

### 6.2 Photo relevance scoring
Every job photo is scored by Claude (vision) before anything else happens, and the score is kept whether or not a post is made:
- **Rubric (0–100 plus reasons):** the door, gate, or opener is the clear subject; the work is finished and clean; framing is straight and well lit; no people, faces, house numbers, license plates, or interiors; no clutter, junk, tools, or vehicles dominating the frame; not blurry or dark.
- **Before/after detection.** Photos from the same job are compared; a recognizable before/after pair is tagged and becomes a two-photo post, which is the best content this feature can produce.
- **Threshold.** `photo_min_score` (default 70). A job with no photo at or above threshold is skipped, never posted with a weak picture. The office can override per photo in the Posts sub-tab, where rejected photos are shown with their reasons.
- **Feedback loop.** Scores roll up into the photo-quality report (§5 item 8) so the training push with techs has numbers behind it.

### 6.3 Photo handling
Google requires a publicly reachable URL, JPG or PNG, 10 KB–5 MB, at least 250×250, best at 1200×900 (4:3). Pipeline: copy from Service Fusion to a public Supabase Storage bucket (`gbp-media`), resize and re-encode, strip EXIF and GPS data, store alongside the score.

### 6.4 Post pipeline
1. Daily at a humanized morning time (dispatcher, §4.5): pick yesterday's completed jobs (mirror `work_completed_at`) in allowed categories (default: installs, spring and opener replacements, gate work; service calls and warranty excluded, editable), with at least one photo at or above threshold, not already posted.
2. Choose up to the daily cap (default 1, weekly cap default 4; both to be set to match the posting cadence of the example profiles in §11), preferring before/after pairs, then job types and cities not posted recently.
3. Claude drafts the post from job category, description, completion notes, services, city or neighborhood, and the Post Charter and style examples. Rules: 80–200 words, plain, no customer name, no street address, no price, **no tech name**, service type plus city in the first sentence, ends with a call to action. Button: "Learn more" or "Call now" with a link to the matching page on castlegaragedoors.com (mapping table by category, editable).
4. Approval on the Posts sub-tab: preview exactly as Google will show it (photo or pair, text, button), Approve / Edit & Approve / Swap photo / Skip. A **Posts autopilot** switch, off at launch, lets approved-quality drafts schedule without review.
5. Publish through the dispatcher: `POST accounts/{a}/locations/{l}/localPosts` with `topicType: STANDARD`, `media` (one or two photos by public URL), `callToAction`. Store the returned post name and state. Standard posts expire after 6 months on Google's side.
6. Link back: `review_replies.linked_post_id` so a reply can mention the shared photos.

### 6.5 Examples from profiles the owner picks
Other businesses' posts are not available through any API. The office pastes 10–20 example posts from the chosen profiles into style examples (`audience='post'`). The Post Charter captures what makes them good (photo first, one job, neighborhood named, short).

### 6.6 Data
- `gbp_posts`: id, sf_job_id, location_id, status (`draft` | `approved` | `scheduled` | `published` | `skipped` | `failed`), photo_ids[], draft_text, final_text, cta_type, cta_url, google_post_name, published_at, approved_by, error.
- `job_photos`: id, sf_job_id, source (`sf` | `tech_upload`), source_ref, storage_path, width, height, score int, score_reasons text[], pair_id, pair_role (`before` | `after`), scored_at, override_usable boolean.
- `reputation_settings` additions: autopilot_posts, cap_posts_daily, cap_posts_weekly, allowed_categories[], cta_map jsonb, photo_min_score.

---

## 7. Feature 5 — Geo-routing review requests to the nearest Google profile

### 7.1 Today
One profile, configured by environment variables (`GOOGLE_BUSINESS_ACCOUNT_ID`, `GOOGLE_BUSINESS_LOCATION_ID`) and one review URL in `csat_settings`. `google_reviews.location_id` exists but is never set.

### 7.2 Change
- New `gbp_locations` table: name, google_account_id, google_location_id, place_id, review_url, address, lat, lng, service_zips[], is_default, is_active. Managed on the Integrations page. The current profile becomes row 1 on migration; the environment variables become the fallback only.
- **Routing rule** per survey, in order: job ZIP in a location's `service_zips` → nearest location by straight-line distance from the ZIP centroid (a static San Diego and Riverside County ZIP centroid table, no geocoding API) → the default location. Stored on `csat_surveys.gbp_location_id`; its review URL is what the 5-star text carries. Admin override per survey in the CSAT sub-tab.
- Ingest loops over every active location and stamps `location_id`. Replies, posts, rank scans, dispatcher caps, and Insights key on it.
- One Google OAuth connection covers all profiles under the same Google account; a profile under a different Google account gets its own refresh token (column on `gbp_locations`).

Until a second profile exists, everything behaves exactly as today. Doing this early makes adding profile 2 a form, not a deploy.

---

## 8. Feature 6 — Map Pack rank tracking

### 8.1 Data provider
Google does not sell rank-grid data; every tool on the market, Big Reputation included, buys it from a provider that queries Google Maps from chosen coordinates. Recommended: **DataForSEO Google Maps SERP API**, Live mode, about $0.002 per request, accepts exact latitude/longitude and zoom, $50 minimum deposit. Alternative: Local Falcon's API at roughly $0.05 per grid point, 25× the cost, with a UI we would not use.

### 8.2 Monitored list (weekly, week-over-week), organized by city and ZIP
The owner's framing is right: rank is high near the Escondido office and lower in nearby cities, so the unit to watch is the city or ZIP, not a county-wide grid. What Big Reputation does is the standard geogrid: a lattice of points around the address, colored by rank, reviewed as a heat map. We do that too, but the monitored list is built from places, not from a lattice:
- Each entry is **keyword × place**, where a place is a city or a ZIP (or a dropped pin). The scan runs from the place's center point, with an optional 3×3 mini-grid around it (about a mile apart) so one bad point does not mislead. Add, edit, pause, remove. Keywords are free text; the defaults are only a starting list and are expected to change.
- A **county-wide grid** (7×7 or 9×9 around the office) remains available as an entry type for the heat-map view, but is optional.
- Suggested starting places, from the service-area list on the website: Escondido, San Marcos, Vista, Oceanside, Carlsbad, Encinitas, Poway, Rancho Bernardo, San Diego (central), Chula Vista, Fallbrook, Bonsall, Temecula, Murrieta, Corona. Fifteen places × 6 keywords with a 3×3 mini-grid is 810 requests a week, about $1.60.
- Weekly cron (Monday early morning) scans every active entry. Each result stores our rank at every point (1–20 or none) and the top 20 businesses per point with rating and review count (feeds §5 item 7).
- Cost example: one 9×9 grid × 8 keywords = 648 requests ≈ $1.30 per week. Ten entries at 7×7 ≈ $1 per week.

### 8.3 Live query
- The Rankings sub-tab has a **Check now** form: keyword + location (address, ZIP, or a pin dropped on the map) + optional grid (single point by default, or a small grid). Results return in seconds: our position, the top 20 with rating and review count, and for a grid the colored squares.
- Every live query is saved, so it can be compared later, and has an **Add to monitored list** button.
- Live queries cost the same per request; a single-point check is a fraction of a cent, a 7×7 grid about 10 cents.

### 8.4 Display
- Map with colored squares (green top 3, yellow 4–10, red 11–20, grey not found), keyword and entry switcher, week-over-week compare with movement arrows per square. Leaflet with OpenStreetMap tiles (no key, no cost).
- Numbers per entry: average rank, share of top-3 points, share of points where we appear, trend line.
- **Job-density overlay**: the same grid colored by completed jobs in the last 90 days (from mirrored job ZIPs). Busy-for-us but red-on-rank squares are the neighborhoods to push, and the evidence for a second profile (§7).
- Competitor table per keyword: who holds the top 3 across the most points, with rating and review count.

### 8.5 What to do about red squares (the playbook the grid drives)
Proximity to the searcher is the single biggest Map Pack factor (Whitespark's 2026 survey puts it near half of the decision), and it cannot be bought. A single address has a ranking ceiling that falls off with distance, and the grid will show exactly where that ceiling is. Within that ceiling, the evidence-backed levers, in order, are:

1. **Review velocity and recency in the last 90 days.** Recent reviews outweigh total count; a stall of a few weeks shows up in rank. Feature 1 (reminders) and the funnel report exist to keep this steady.
2. **Owner reply rate above roughly 80%, with the city and service named in the reply.** Controlled tests found keywords in the customer's review text do not move rank, but keywords in the owner's reply do, because Google indexes owner replies. This is why §4.2 requires the service type and city or neighborhood in every reply, and why replying to the historical backlog (§4.4) is worth doing.
3. **Profile basics.** Primary category, a complete services list, correct service area, consistent name/address/phone across directories. One-time audit, then monitored quarterly.
4. **A real page on castlegaragedoors.com for each neighborhood that matters**, with jobs actually done there, photos from those jobs, and structured data (`areaServed`). The site already has service-area pages; the grid tells us which ones to add or deepen. Feature 4's scored photos are the raw material.
5. **Profile posts** for freshness and click-through, not rank (§2).
6. **A second profile only with a real staffed office.** Google suspends listings at virtual offices, mailboxes, and unstaffed coworking desks; the address must have signage and Castle's own staff during posted hours. A staffed second location (for example in Riverside County) is the only way to lift the ceiling far from Escondido. §7 is ready for it; the grid plus job density is the business case for it.

**Neighborhood scorecard (monitored, on the Rankings sub-tab).** For each grid cluster the office names (for example Carlsbad, Temecula, Chula Vista), one row that combines data only Castle has, because reviews are matched to jobs and jobs carry ZIPs:

| Column | Source |
|---|---|
| Rank now, 4-week trend, by keyword | §8.2 scans |
| Jobs completed there, last 90 days | mirrored jobs by ZIP |
| Reviews earned there, last 90 days, and their average | matched reviews by job ZIP |
| Review funnel conversion there | §5 item 1 filtered by ZIP |
| Share of those reviews replied, and replied within 48h | `review_replies` |
| Area page on the website: exists, last updated | a small table maintained by the office, `area_pages` (neighborhood, URL, updated_at) |
| Top competitor there and their rating/count | §8.2 results |

Movement rules turn the scorecard into a to-do list: busy but few reviews → the funnel is leaking there, check the survey exclusions and reminders; reviews fine but unreplied → the backlog button; jobs and reviews fine, still red → the area page is missing or thin; nothing works beyond the distance ceiling → second-office evidence.

### 8.6 Data
`rank_monitors` (id, location_id, keyword, center_lat, center_lng, grid_size, spacing_miles, is_active), `area_pages` (neighborhood, zips[], url, updated_at), `rank_scans` (id, monitor_id nullable, keyword, center, grid jsonb, run_at, source `weekly` | `live`, status), `rank_scan_points` (scan_id, row, col, lat, lng, our_rank, results jsonb).

---

## 9. Cross-cutting

### 9.1 Where it lives: the Reviews main tab
Everything in this PRD sits under the existing **Reviews** main tab. Existing sub-tabs are reused; three are added.

| Sub-tab | Exists? | What changes |
|---|---|---|
| **CSAT** | Yes | Gains the two reminder templates and delay in its settings; shows the routed profile per survey once §7 exists |
| **Google Reviews** | Yes | Each review card shows its reply draft, status, and scheduled time inline; new filters "Needs approval" and "Backlog"; a badge with the needs-approval count; the "Draft replies for old reviews" button; Approve / Edit & Approve / Skip on the card |
| **Posts** | New | Post drafts with photo previews, scores and rejection reasons, approval, published history |
| **Rankings** | New | Monitored list results, live "Check now" query, job-density overlay, competitor table, neighborhood scorecard |
| **Insights** | New | Everything in §5 |
| **Settings** | New | Autopilot switches and pause, working window and stagger rules, caps, Reply Charter and Post Charter, standing instructions, style examples by band, allowed post categories, photo threshold, monitored keyword list, CTA link map |

The tech-facing reviews page (read-only) is unchanged.

### 9.2 Crons (Vercel allows 100 per project; 33 in use)
| Path | Schedule | Feature |
|---|---|---|
| `ingest-google-reviews` | every 30 minutes (was daily); drafting runs at the end of each sync | 2, 3 |
| `reputation-dispatch` | every minute; sends whatever is due under the stagger rules | 2, 3, 4 |
| `gbp-posts-prepare` | daily 6:10am PT; scores photos, drafts, queues | 4 |
| `gbp-performance-daily` | daily 6:40am PT | 3 |
| `rank-scan-weekly` | Monday 4:50am PT | 6 |
| `reputation-weekly-digest` | Monday 7:05am PT | 3 |

### 9.3 Running costs (estimates)
| Item | Monthly |
|---|---|
| Claude calls (replies, tagging, post drafts, photo scoring) at Castle's review and job volume | roughly $15–40 (photo scoring is the largest share) |
| DataForSEO weekly scans plus occasional live checks | roughly $5–10 |
| Supabase Storage for post photos | under $1 |
| Google APIs used | $0 |

### 9.4 One-time setup (owner or office involvement)
1. Confirm the existing Google OAuth token was granted with the `business.manage` scope (reads use the same scope; re-authorize once if not).
2. Enable the Business Profile Performance API in the same Google Cloud project.
3. Run the Service Fusion `expand=pictures` test (§6.1).
4. Create a DataForSEO account and fund the $50 minimum.
5. Create the public `gbp-media` storage bucket.
6. Paste example replies (positive and negative) and posts from the chosen profiles (§4.7, §6.5).
7. Approve the Reply Charter and Post Charter (drafts will be provided).

### 9.5 Risks
- **Review gating.** The Google link goes only to customers who text a 5. Google's April 2026 policy update treats selective solicitation as rating manipulation, with review removal and profile suspension as penalties. Big Reputation's "smart routing" is the same practice. This PRD does not change the current behavior; the decision is in §11.
- **Looking automated.** The dispatcher's window, odd minutes, spacing, caps, and skipped hours exist to keep the profile looking like a person answering. Turning caps up or the window wide undoes that.
- **Posting on a service-area business.** Proximity ranking is measured from the profile address. Posts and reviews will not make one address rank county-wide; the rank grid shows where the ceiling is.
- **Photo privacy and quality.** Only scored, screened product photos are published; no people, house numbers, or plates. Customers and techs are never named.
- **Negative-review autopilot.** Expected to stay off until the negative example pool is large enough; the switch shows its edit rate so that call is informed.

---

## 10. Phasing and effort

| Phase | Weeks | Contents |
|---|---|---|
| 1 | 1–2.5 | Per-customer short links and 2-day reminders (§3); reply agent with both autopilot switches, backlog button, and the dispatcher (§4); AI tagging at sync with backfill (§5 item 2); Settings sub-tab |
| 2 | 3–4.5 | Service Fusion photo test, photo scoring and pairing, post drafting, approval, publish through the dispatcher (§6); Insights sub-tab items 1, 3, 4, 5, 8, 9 |
| 3 | 5–6 | Monitored rank list, weekly scans, live Check now, Rankings sub-tab with job-density overlay (§8); Performance API and competitor benchmark; per-tech scorecard |
| 4 | 7 | Multi-location tables, routing, Integrations UI (§7) |

About seven weeks of build. Phases 1 and 2 deliver the two headline features. Phase 4 can move earlier if a second profile is imminent.

---

## 11. Decisions recorded (owner, 2026-09-12) and what is still open

| Topic | Decision |
|---|---|
| Example profiles for replies and posts | Four Google profiles supplied as share links (§11.1). Resolving them to business names and studying their reply style and posting cadence is the first task of the build; those findings seed the Reply Charter, the Post Charter, the posting caps, and the first style examples. |
| Who approves while autopilot is off | Admins, to start. |
| Reply speed | Governed by the humanized scheduler in §4.5: 1–6 hours after the review is seen, inside the working window, odd minutes, spaced out. Sync every 30 minutes. |
| Posting cadence and categories | Match what the example profiles do; caps in §6.4 are placeholders until then. |
| Photos | Techs already take photos in the Service Fusion app. Relevance and quality scoring (§6.2) is mandatory; nothing posts without a scored photo, and the photo-quality report feeds tech training. |
| Rank tracking scope | City and ZIP based, not a county grid, because rank is strong near the office and weaker in nearby cities (§8.2). County heat map optional. |
| Review link only after a 5 | Keep as is. The gating risk in §9.5 stays noted; no change. |
| Second Google profile | Planned, likely within a few months. Phase 4 (§7) stays at week 7, which lands before the profile exists; it moves earlier if the office date firms up. Reminder: the address must be a real, staffed, signed office (§8.5 item 6). |
| Reply signature | "Castle team". |

### 11.1 Example profiles supplied
- https://share.google/AQ2xmYkZpTEgFuQDr
- https://share.google/4YqbMk6XNM2JKYffP
- https://share.google/8qmO6ol57New3mGrv
- https://share.google/GuEhzqsiK1SPxmC8C

These could not be opened from the planning session's network, so the business names are not yet recorded here.

### 11.2 Still open
1. Working window default (§4.5): Monday–Friday 7:40am–6:20pm, Saturday 8:30am–2:10pm, Sunday off, unless told otherwise.
2. Backlog scope and pace (§4.4): every unreplied historical review, at 3 a day, unless told otherwise.
3. Starting keyword list and any competitors to name for the monitored list (§8.2). The suggested places are listed there.
