-- Allow technicians to delete their own week submission (to re-open a submitted week before the deadline)
create policy "tech_own_submissions_delete" on public.week_submissions
  for delete using (tech_id = auth.uid());
