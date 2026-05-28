-- Techs need to UPDATE week_submissions when re-submitting an admin-unlocked week.
-- The upsert in handleSubmitWeek triggers an UPDATE on conflict, which had no policy.

create policy "tech_own_submissions_update" on public.week_submissions
  for update using (tech_id = auth.uid())
  with check (tech_id = auth.uid());
