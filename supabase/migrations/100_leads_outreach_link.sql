-- SFI lead outreach link tracking (Phase 1). The outreach SMS/email currently
-- sends the same shared vanity link (sfi.cstle.co) to every lead, so a click is
-- not attributable to a lead. Switch to a PER-LEAD short link and record its
-- code here, so we can join to short_links (click_count / last_clicked_at) and
-- see who actually opened the scheduler — the SFI equivalent of "did they reach
-- the calendar". No scheduler-flow changes.

alter table public.leads
  add column if not exists outreach_link_code text;   -- short_links.code sent to this lead
