-- Fix mutable search_path on both functions and restrict is_admin to authenticated only.

create or replace function public.is_admin()
returns boolean language sql security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

-- Revoke execute from anon — is_admin is only meaningful for signed-in users.
revoke execute on function public.is_admin() from anon;

create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
