-- Allow sales role to read and write action item notes
drop policy if exists "Admin full access to action_item_notes" on public.action_item_notes;
drop policy if exists "Admin and sales access to action_item_notes" on public.action_item_notes;

create policy "Admin and sales access to action_item_notes"
  on public.action_item_notes
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('admin', 'sales')
    )
  );
