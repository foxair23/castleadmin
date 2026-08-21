# Growth Driver Ideas

A backlog of growth initiatives for Castle Garage Doors & Gates, filed for later.
Thesis: Castle already has a strong ops nervous system (Action Items, SF mirror,
commission engine, CSAT, review ingestion, LeadGen, scheduler, remittances). The
biggest near-term growth is **turning passive alert dashboards into active
automation** — most of these reuse machinery that already exists (toggle + cutoff
+ cron + SMS/email templates) — plus a few new revenue loops.

Status: **parked** — revisit and rank against real data before building.

---

## 1. Speed-to-lead auto-response (highest ROI, cheap)
The instant a lead lands, auto-fire a personalized SMS + book-link before a human
touches it. Response time is the #1 conversion lever in home services (<5 min vs
1 hr can 5–8× contact rates). Reuses Dialpad SMS + Resend + the LeadGen inbound
pipeline + the nudge pattern. Directly attacks the "SFI Leads / not booked within
an hour" leak.

## 2. Automated estimate close loops ("Stale Estimates" + "Accepted-No-Job")
Those Action Items tabs are money leaking out while waiting on a human. Automate
estimate follow-up (day 2/5/10 email+SMS) using the invoice-reminder machinery,
and extend the existing tokenized `/approve/` flow so a customer can **accept an
estimate + pay a deposit in one tap**. Add **financing** ("as low as $X/mo") at
the estimate to lift close rate and average ticket on installs.

## 3. Auto-invoice on completion + pay-by-link (cash flow)
"Never Invoiced" and "Unpaid Jobs" tabs = completed work not yet cash. Auto-
generate the SF invoice when a job is marked complete and text a pay-link
immediately (move the first invoice reminder to completion, not days later).
Faster cash → more capacity.

## 4. Maintenance membership (recurring revenue + retention)
Package "Annual Maintenance" as a membership ($X/yr: annual tune-up, priority
scheduling, discount on repairs). Converts one-time customers into a recurring
base, smooths slow months, creates repeat upsell/replacement touchpoints, and
raises enterprise value.

## 5. Review-velocity engine (local SEO flywheel)
Post-job, CSAT-gate to Google: happy customers get a one-tap Google review link,
unhappy ones route privately to the office first. More 5-star velocity → higher
local-pack ranking → more organic leads at ~$0 CAC. Builds on existing CSAT +
Google review ingestion.

## 6. Reactivation campaigns from SF history
Mine the SF mirror for aging customers (door installed 10+ yrs ago = due; past
repair customers due for springs/service) and run "it's been a while" specials.
Cheapest leads available — customers who already trust Castle.

## 7. Channel P&L / LTV analytics (allocate spend)
Build a channel-level profit + lifetime-value dashboard across website scheduler,
marketing leads, Genie/Home Depot, and Clopay STS (using commission + job-source
data) so acquisition spend goes to the most profitable channel, not the loudest.

---

## Before building: validate with real data
Rank the above by dollars using the SF mirror, not intuition. Key metrics to pull:
- Estimate → job conversion rate, and $ stuck in "accepted-no-job."
- Average days-to-invoice and total uninvoiced $ outstanding.
- Lead → booked rate by source (which channel converts best).
- Repeat-customer % and time-since-last-service distribution.

These four tell us which initiative is worth the most, in dollars, before we build.
