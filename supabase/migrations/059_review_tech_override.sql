-- Per-review tech override.
--
-- Reviews credit a tech by deriving it from the matched job's assigned techs
-- (sf_job_techs). But that mirror only holds JOB-LEVEL techs — the tech listed on
-- the job record itself — not the tech on each individual site visit. When a job
-- has a later site visit performed by a different tech, the review is really
-- about that visit, yet the job-derived credit still points at the original
-- (job-level) tech. Visit-level techs aren't mirrored, so there's no automatic
-- way to correct this.
--
-- This column lets an admin pin the credited tech directly on the review. When
-- set, it overrides the job-derived tech everywhere the review is attributed
-- (the reviews list and the leaderboard). NULL = fall back to the job-derived
-- tech, i.e. existing behavior.
alter table google_reviews
  add column if not exists matched_tech_user_id uuid references profiles(id);

comment on column google_reviews.matched_tech_user_id is
  'Admin override for the credited tech. When set, wins over the tech derived from the matched job''s sf_job_techs (which is job-level only and misses later site-visit techs).';
