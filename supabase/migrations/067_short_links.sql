-- Short links (for shortening the long Service Fusion pay URLs in SMS/email).
--
-- Codes are a deterministic hash of the target, so the same URL always maps to
-- the same code (no duplicates). The resolver at /p/[code] redirects and counts
-- clicks. Public reads happen via the service role in that route; direct table
-- access stays admin-only.
create table if not exists public.short_links (
  code            text primary key,
  target_url      text not null,
  created_at      timestamptz not null default now(),
  click_count     int not null default 0,
  last_clicked_at timestamptz
);
create index if not exists idx_short_links_target on public.short_links(target_url);

-- Atomic click bump for the resolver.
create or replace function public.bump_short_link(p_code text) returns void
  language sql as $$
    update public.short_links
       set click_count = click_count + 1, last_clicked_at = now()
     where code = p_code;
  $$;

alter table public.short_links enable row level security;
drop policy if exists "admin_all_short_links" on public.short_links;
create policy "admin_all_short_links" on public.short_links for all using (public.is_admin());
