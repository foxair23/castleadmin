-- ============================================================
-- 030_email_notifications.sql
-- Email notification infrastructure: types, preferences, log
-- ============================================================

-- ── 1. Add is_dispatch to profiles ─────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_dispatch boolean NOT NULL DEFAULT false;

-- ── 2. notification_types ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_types (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key                  text        NOT NULL UNIQUE,
  display_name         text        NOT NULL,
  description          text,
  category             text        NOT NULL,
  default_for_roles    text[]      NOT NULL DEFAULT '{}',
  default_for_dispatch boolean     NOT NULL DEFAULT false,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Seed notification types ──────────────────────────────
INSERT INTO public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
VALUES
  (
    'piecework_reminder',
    'Piecework Submission Reminder',
    'Reminder to submit piecework before the Wednesday deadline',
    'payroll',
    ARRAY['technician'],
    false
  ),
  (
    'lead_assigned',
    'Scheduler Lead Assigned',
    'Notification when a new lead is booked through the scheduler',
    'scheduler',
    ARRAY['sales'],
    false
  ),
  (
    'sync_not_run',
    'SF Sync Not Run',
    'Alert when Service Fusion sync has not run successfully in 30+ hours',
    'ops',
    ARRAY['admin'],
    false
  ),
  (
    'scheduler_lead_synced',
    'Scheduler Lead Synced to SF',
    'Notification when a scheduler lead is successfully synced to Service Fusion',
    'scheduler',
    ARRAY[]::text[],
    true
  ),
  (
    'scheduler_lead_stuck',
    'Scheduler Lead Stuck',
    'Alert when a scheduler lead fails to sync or requires manual push',
    'scheduler',
    ARRAY['admin'],
    false
  )
ON CONFLICT (key) DO NOTHING;

-- ── 4. user_notification_preferences ───────────────────────
CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notification_type_id uuid        NOT NULL REFERENCES public.notification_types(id),
  is_enabled           boolean     NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid        REFERENCES public.profiles(id),
  UNIQUE (user_id, notification_type_id)
);

-- ── 5. notification_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES public.profiles(id),
  notification_type_id uuid        NOT NULL REFERENCES public.notification_types(id),
  related_entity_type  text,
  related_entity_id    text,
  subject              text        NOT NULL,
  body_html            text,
  body_text            text,
  payload              jsonb,
  status               text        NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts             int         NOT NULL DEFAULT 0,
  send_after           timestamptz NOT NULL DEFAULT now(),
  error_message        text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ── 6. Indexes ──────────────────────────────────────────────
-- Worker pickup: queued/failed rows ready to send
CREATE INDEX IF NOT EXISTS notification_log_worker_idx
  ON public.notification_log (send_after, status)
  WHERE status IN ('queued', 'failed');

-- Dedup: find existing rows for a given entity+type
CREATE INDEX IF NOT EXISTS notification_log_dedup_idx
  ON public.notification_log (notification_type_id, related_entity_type, related_entity_id, status);

-- Batch grouping: find pending batched rows for a user+type
CREATE INDEX IF NOT EXISTS notification_log_batch_idx
  ON public.notification_log (user_id, notification_type_id, send_after)
  WHERE status = 'queued';

-- Preferences lookup
CREATE INDEX IF NOT EXISTS user_notification_prefs_user_idx
  ON public.user_notification_preferences (user_id);

-- ── 7. RLS ──────────────────────────────────────────────────
ALTER TABLE public.notification_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

-- notification_types: all authenticated users can read; admins manage
CREATE POLICY "authenticated_read_notification_types"
  ON public.notification_types FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_manage_notification_types"
  ON public.notification_types FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- user_notification_preferences: users read their own; admins manage all
CREATE POLICY "users_read_own_prefs"
  ON public.user_notification_preferences FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "admin_manage_prefs"
  ON public.user_notification_preferences FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- notification_log: users read their own; admins manage all
CREATE POLICY "users_read_own_log"
  ON public.notification_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "admin_manage_log"
  ON public.notification_log FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 8. Trigger: auto-populate preferences on new profile ───
CREATE OR REPLACE FUNCTION public.auto_populate_notification_preferences()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Role-based defaults
  INSERT INTO public.user_notification_preferences (user_id, notification_type_id, is_enabled)
  SELECT NEW.id, nt.id, true
  FROM public.notification_types nt
  WHERE nt.is_active = true
    AND NEW.role = ANY(nt.default_for_roles)
  ON CONFLICT (user_id, notification_type_id) DO NOTHING;

  -- Dispatch-based defaults (is_dispatch can be set on creation)
  IF NEW.is_dispatch = true THEN
    INSERT INTO public.user_notification_preferences (user_id, notification_type_id, is_enabled)
    SELECT NEW.id, nt.id, true
    FROM public.notification_types nt
    WHERE nt.is_active = true
      AND nt.default_for_dispatch = true
    ON CONFLICT (user_id, notification_type_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_populate_notification_preferences
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_populate_notification_preferences();

-- ── 9. Trigger: handle is_dispatch toggle on profile update ─
CREATE OR REPLACE FUNCTION public.handle_is_dispatch_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_dispatch = true AND OLD.is_dispatch = false THEN
    -- Dispatch turned on: upsert scheduler_lead_synced preference as enabled
    INSERT INTO public.user_notification_preferences (user_id, notification_type_id, is_enabled, updated_at)
    SELECT NEW.id, nt.id, true, now()
    FROM public.notification_types nt
    WHERE nt.is_active = true
      AND nt.default_for_dispatch = true
    ON CONFLICT (user_id, notification_type_id) DO UPDATE
      SET is_enabled = true, updated_at = now();

  ELSIF NEW.is_dispatch = false AND OLD.is_dispatch = true THEN
    -- Dispatch turned off: disable (preserve row, don't delete)
    UPDATE public.user_notification_preferences unp
    SET is_enabled = false, updated_at = now()
    FROM public.notification_types nt
    WHERE unp.user_id = NEW.id
      AND unp.notification_type_id = nt.id
      AND nt.default_for_dispatch = true;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_handle_is_dispatch_change
  AFTER UPDATE OF is_dispatch ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_dispatch IS DISTINCT FROM NEW.is_dispatch)
  EXECUTE FUNCTION public.handle_is_dispatch_change();

-- ── 10. Backfill preferences for existing users ─────────────
-- Role-based defaults
INSERT INTO public.user_notification_preferences (user_id, notification_type_id, is_enabled)
SELECT p.id, nt.id, true
FROM public.profiles p
CROSS JOIN public.notification_types nt
WHERE nt.is_active = true
  AND p.role = ANY(nt.default_for_roles)
ON CONFLICT (user_id, notification_type_id) DO NOTHING;

-- Dispatch-based defaults (for any existing dispatch users)
INSERT INTO public.user_notification_preferences (user_id, notification_type_id, is_enabled)
SELECT p.id, nt.id, true
FROM public.profiles p
CROSS JOIN public.notification_types nt
WHERE nt.is_active = true
  AND nt.default_for_dispatch = true
  AND p.is_dispatch = true
ON CONFLICT (user_id, notification_type_id) DO NOTHING;
