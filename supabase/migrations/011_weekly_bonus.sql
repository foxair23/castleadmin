-- Add weekly_bonus to profiles: a flat dollar amount added to a tech's
-- weekly piecework pay (e.g. for a people-manager stipend).
alter table public.profiles
  add column if not exists weekly_bonus numeric(10,2) not null default 0;
