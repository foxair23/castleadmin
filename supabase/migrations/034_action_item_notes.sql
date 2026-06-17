create table if not exists public.action_item_notes (
  id           uuid        primary key default gen_random_uuid(),
  entity_type  text        not null,
  entity_id    text        not null,
  note         text        not null default '',
  updated_at   timestamptz not null default now(),
  created_by   uuid        references auth.users(id),
  unique (entity_type, entity_id)
);

alter table public.action_item_notes enable row level security;

create policy "Admin full access to action_item_notes"
  on public.action_item_notes
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
