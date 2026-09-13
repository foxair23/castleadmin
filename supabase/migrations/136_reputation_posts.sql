-- Reputation Engine, Phase 2 (PRD castle-prd-reputation.md §5, §6):
-- Google Business Profile posts from yesterday's jobs, with photo relevance
-- scoring; the Insights tab's data needs; and the weekly reputation digest.
--
-- Safety posture: the posts autopilot switch defaults OFF, so every post waits
-- for a person. Nothing is published without a photo that passed scoring.
-- updated_at columns are maintained by application code (no triggers).

-- ── reputation_settings: posting knobs ───────────────────────────────────────
alter table public.reputation_settings add column if not exists autopilot_posts          boolean not null default false;
alter table public.reputation_settings add column if not exists cap_posts_weekly         int not null default 4;
-- SF job category NAMES allowed to become posts. Empty = every category except
-- ones whose name looks like warranty / estimate / service call.
alter table public.reputation_settings add column if not exists post_allowed_categories  text[] not null default '{}';
-- Button link per category: [{"match": "gate", "path": "/services/gate-services/", "cta": "LEARN_MORE"}, …]
-- matched case-insensitively against the category name, first hit wins; the
-- path is appended to the marketing site URL (lib/config/domains.ts).
alter table public.reputation_settings add column if not exists post_cta_map             jsonb not null default
  '[{"match":"gate","path":"/services/gate-services/","cta":"LEARN_MORE"},
    {"match":"opener","path":"/services/garage-door-openers/","cta":"LEARN_MORE"},
    {"match":"install|new door|replacement","path":"/services/garage-door-installation/","cta":"LEARN_MORE"},
    {"match":"repair|spring|cable|roller|panel|service","path":"/services/garage-door-repair/","cta":"LEARN_MORE"},
    {"match":".*","path":"/services/","cta":"LEARN_MORE"}]'::jsonb;
alter table public.reputation_settings add column if not exists photo_min_score          int not null default 70;
alter table public.reputation_settings add column if not exists posts_since              timestamptz not null default now();  -- jobs completed before this are never auto-picked

-- ── job_photos: every job picture we have looked at, with its relevance score ─
create table if not exists public.job_photos (
  id               uuid primary key default gen_random_uuid(),
  sf_job_id        text not null,
  source           text not null default 'sf' check (source in ('sf','tech_upload')),
  source_ref       text not null,                          -- SF file_location (or upload id)
  source_name      text,
  storage_path     text,                                   -- gbp-media object path once copied
  public_url       text,                                   -- what Google is given
  width            int,
  height           int,
  bytes            int,
  score            int,                                    -- 0–100 relevance (null = not scored)
  score_reasons    text[] not null default '{}',
  shows            text check (shows in ('before','after','finished','other')),
  subject          text,                                   -- "double garage door", "driveway gate"
  pair_id          uuid,                                   -- before/after pair grouping
  override_usable  boolean,                                -- admin override of the threshold
  scored_at        timestamptz,
  score_model      text,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sf_job_id, source_ref)
);
create index if not exists idx_job_photos_job on public.job_photos(sf_job_id);

-- ── gbp_posts ────────────────────────────────────────────────────────────────
create table if not exists public.gbp_posts (
  id                uuid primary key default gen_random_uuid(),
  sf_job_id         text not null,
  location_id       text,
  status            text not null default 'draft'
    check (status in ('draft','approved','scheduled','published','skipped','failed')),
  photo_ids         uuid[] not null default '{}',          -- job_photos.id, in display order (1 or 2)
  draft_text        text not null,
  final_text        text,
  cta_type          text not null default 'LEARN_MORE',    -- LEARN_MORE | CALL
  cta_url           text,
  guardrail_notes   jsonb not null default '{}'::jsonb,
  model             text,
  prompt_version    int,
  charter_version   int,
  style_example_ids uuid[] not null default '{}',
  google_post_name  text,                                  -- accounts/…/locations/…/localPosts/…
  google_state      text,
  approved_by       uuid references auth.users(id),        -- null + approved_at set = autopilot
  approved_at       timestamptz,
  scheduled_for     timestamptz,
  published_at      timestamptz,
  push_reasons      text[] not null default '{}',
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_gbp_posts_status on public.gbp_posts(status, created_at desc);
create index if not exists idx_gbp_posts_job on public.gbp_posts(sf_job_id);
create unique index if not exists gbp_posts_one_live on public.gbp_posts(sf_job_id)
  where status in ('draft','approved','scheduled','published');

-- ── Public media bucket (Google fetches post photos by URL) ───────────────────
-- The first public bucket in this project: only screened, resized, EXIF-stripped
-- product photos are written here, never customer documents.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gbp-media', 'gbp-media', true, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = true;

drop policy if exists "service_role_all_gbp_media" on storage.objects;
create policy "service_role_all_gbp_media"
  on storage.objects for all
  using (bucket_id = 'gbp-media' and (select auth.role()) = 'service_role');
drop policy if exists "public_read_gbp_media" on storage.objects;
create policy "public_read_gbp_media"
  on storage.objects for select
  using (bucket_id = 'gbp-media');

-- ── RLS + grants for the new tables ──────────────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['job_photos','gbp_posts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

-- ── Weekly reputation digest (Monday email) ─────────────────────────────────
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'reputation_weekly_digest',
  'Weekly Reputation Digest',
  'Monday summary: new Google reviews, survey funnel, replies waiting, posts published, top theme, photo quality.',
  'operations',
  array['admin'],
  false
)
on conflict (key) do nothing;

insert into public.user_notification_preferences (user_id, notification_type_id, is_enabled)
select p.id, nt.id, true
from public.profiles p
cross join public.notification_types nt
where nt.key = 'reputation_weekly_digest' and p.role = 'admin'
on conflict (user_id, notification_type_id) do nothing;
