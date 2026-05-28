-- Fix: RLS policies on jobs and job_work_items currently block any write
-- when a week_submissions row exists, regardless of admin_unlocked state.
-- When admin unlocks a week, the row has submitted_at = NULL and admin_unlocked = true.
-- Policies must only block writes when submitted_at IS NOT NULL (truly submitted).

drop policy if exists "tech_own_jobs_insert"       on public.jobs;
drop policy if exists "tech_own_jobs_update"       on public.jobs;
drop policy if exists "tech_own_jobs_delete"       on public.jobs;
drop policy if exists "tech_own_work_items_insert" on public.job_work_items;
drop policy if exists "tech_own_work_items_delete" on public.job_work_items;

create policy "tech_own_jobs_insert" on public.jobs
  for insert with check (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
        and ws.submitted_at is not null
    )
  );

create policy "tech_own_jobs_update" on public.jobs
  for update using (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
        and ws.submitted_at is not null
    )
  );

create policy "tech_own_jobs_delete" on public.jobs
  for delete using (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
        and ws.submitted_at is not null
    )
  );

create policy "tech_own_work_items_insert" on public.job_work_items
  for insert with check (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.tech_id = auth.uid()
        and not exists (
          select 1 from public.week_submissions ws
          where ws.tech_id = auth.uid()
            and ws.week_start_date = j.week_start_date
            and ws.submitted_at is not null
        )
    )
  );

create policy "tech_own_work_items_delete" on public.job_work_items
  for delete using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.tech_id = auth.uid()
        and not exists (
          select 1 from public.week_submissions ws
          where ws.tech_id = auth.uid()
            and ws.week_start_date = j.week_start_date
            and ws.submitted_at is not null
        )
    )
  );
