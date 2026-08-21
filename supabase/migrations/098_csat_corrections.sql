-- CSAT score corrections: provenance on each recorded rating (bare SMS, an
-- AI-interpreted natural-language correction, or an admin edit), plus a flag to
-- HOLD the automated Google-review request when a rating was upgraded by an AI
-- inference (the office confirms before we ask an unhappy-turned-happy customer
-- for a public review).

-- Where a recorded rating came from + who set it (admin edits).
alter table public.csat_responses
  add column if not exists source     text,   -- 'sms' | 'ai_correction' | 'admin_edit' (null = legacy sms)
  add column if not exists edited_by  uuid references public.profiles(id);

-- When true, the current rating is review-eligible (5) but the Google-review
-- text was NOT auto-sent (it came from an AI-inferred correction) — the office
-- can send it with one tap from the CSAT tab. Cleared once sent.
alter table public.csat_surveys
  add column if not exists review_pending_confirm boolean not null default false;
