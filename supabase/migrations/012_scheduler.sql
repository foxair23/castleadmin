-- ============================================================
-- Castle Online Scheduler — Schema
-- ============================================================
-- All scheduler tables are accessed exclusively via API routes
-- using the service role client. RLS policies are admin-only
-- for any direct Supabase client access.

-- ── Booking ID sequence ───────────────────────────────────────────────────
-- IDs are formatted CGD-{YYYY}-{00001} by the generate_lead_id() function.
-- Sequence never resets — year in the ID is the creation year, not the
-- sequence partition. This keeps IDs globally unique across years.

CREATE SEQUENCE IF NOT EXISTS scheduler_lead_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_lead_id()
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  seq_val bigint;
  year_str text;
BEGIN
  seq_val := nextval('public.scheduler_lead_seq');
  year_str := to_char(now() AT TIME ZONE 'America/Los_Angeles', 'YYYY');
  RETURN 'CGD-' || year_str || '-' || lpad(seq_val::text, 5, '0');
END;
$$;

-- ── Settings (key-value store) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id)
);

-- ── Settings audit log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_settings_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES public.profiles(id),
  key        text NOT NULL,
  old_value  jsonb,
  new_value  jsonb NOT NULL
);

-- ── Widget instances ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_widget_instances (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  lead_source  text NOT NULL,
  api_key      text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES public.profiles(id)
);

-- ── Service area: city list (admin-editable) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_service_area_cities (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city      text NOT NULL,
  state     text NOT NULL DEFAULT 'CA',
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (city, state)
);

-- ── City → zip reference mapping (read-only, derived) ────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_city_zip_map (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city  text NOT NULL,
  state text NOT NULL DEFAULT 'CA',
  zip   text NOT NULL,
  UNIQUE (city, state, zip)
);

-- ── Leads — source of truth for every booking ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_leads (
  -- Identity
  id         text PRIMARY KEY DEFAULT public.generate_lead_id(),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Workflow status (office decision)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Sync status (Service Fusion handoff, independent of status)
  sync_status text NOT NULL DEFAULT 'not_attempted'
    CHECK (sync_status IN (
      'not_attempted', 'in_progress', 'synced', 'sync_failed', 'manually_synced'
    )),

  -- Attribution
  lead_source        text NOT NULL DEFAULT 'website',
  widget_instance_id text REFERENCES public.scheduler_widget_instances(id),

  -- Service details
  service_type     text NOT NULL CHECK (service_type IN ('garage_door', 'gate')),
  service_category text NOT NULL,
  diagnostic_answers jsonb NOT NULL DEFAULT '{}',

  -- Customer
  customer_first_name              text NOT NULL,
  customer_last_name               text NOT NULL,
  customer_phone                   text NOT NULL,
  customer_email                   text NOT NULL,
  customer_sms_appointment_consent boolean NOT NULL DEFAULT false,
  customer_sms_marketing_consent   boolean NOT NULL DEFAULT false,

  -- Address
  address_line1          text NOT NULL,
  address_line2          text,
  address_city           text NOT NULL,
  address_state          text NOT NULL DEFAULT 'CA',
  address_zip            text NOT NULL,
  address_is_owner       boolean NOT NULL DEFAULT true,
  address_in_service_area boolean,

  -- Appointment
  appointment_date         date NOT NULL,
  appointment_window_start text NOT NULL,  -- '08:00'
  appointment_window_end   text NOT NULL,  -- '12:00'
  appointment_timezone     text NOT NULL DEFAULT 'America/Los_Angeles',

  -- Content
  description       text,
  incentive_applied text,

  -- Service Fusion
  service_fusion_customer_id text,
  service_fusion_job_id      text,
  sync_attempts              jsonb NOT NULL DEFAULT '[]',
  synced_at                  timestamptz,

  -- Approval audit trail (unambiguous: human vs system)
  auto_approved   boolean NOT NULL DEFAULT false,
  approved_by     uuid REFERENCES public.profiles(id),
  approved_at     timestamptz,
  rejected_reason text,

  -- Internal
  notes_internal text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sched_leads_status      ON public.scheduler_leads(status);
CREATE INDEX IF NOT EXISTS idx_sched_leads_sync_status ON public.scheduler_leads(sync_status);
CREATE INDEX IF NOT EXISTS idx_sched_leads_created_at  ON public.scheduler_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_leads_appt_date   ON public.scheduler_leads(appointment_date);
CREATE INDEX IF NOT EXISTS idx_sched_leads_phone       ON public.scheduler_leads(customer_phone);
CREATE INDEX IF NOT EXISTS idx_sched_leads_email       ON public.scheduler_leads(customer_email);
CREATE INDEX IF NOT EXISTS idx_sched_leads_widget      ON public.scheduler_leads(widget_instance_id);
CREATE INDEX IF NOT EXISTS idx_sched_leads_service_area ON public.scheduler_leads(address_in_service_area);

-- ── Lead attachments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduler_lead_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      text NOT NULL REFERENCES public.scheduler_leads(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  storage_path text NOT NULL,  -- Supabase Storage path: scheduler-uploads/{lead_id}/{filename}
  mime_type    text NOT NULL,
  size_bytes   int NOT NULL,
  service_fusion_attachment_id text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sched_attachments_lead ON public.scheduler_lead_attachments(lead_id);

-- ============================================================
-- Row-Level Security
-- ============================================================
-- All scheduler tables are accessed via service-role API routes.
-- RLS policies are admin-only for any direct Supabase client access.

ALTER TABLE public.scheduler_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_settings_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_widget_instances     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_service_area_cities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_city_zip_map         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_leads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_lead_attachments     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_scheduler_settings"
  ON public.scheduler_settings FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_settings_log"
  ON public.scheduler_settings_log FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_widget_instances"
  ON public.scheduler_widget_instances FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_service_area_cities"
  ON public.scheduler_service_area_cities FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_city_zip_map"
  ON public.scheduler_city_zip_map FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_leads"
  ON public.scheduler_leads FOR ALL USING (public.is_admin());

CREATE POLICY "admin_all_scheduler_lead_attachments"
  ON public.scheduler_lead_attachments FOR ALL USING (public.is_admin());

-- ============================================================
-- Explicit grants (required per Supabase Oct 2026 Data API change)
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_settings            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_settings_log        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_widget_instances    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_service_area_cities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_city_zip_map        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_leads               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_lead_attachments    TO authenticated;

GRANT ALL ON public.scheduler_settings            TO service_role;
GRANT ALL ON public.scheduler_settings_log        TO service_role;
GRANT ALL ON public.scheduler_widget_instances    TO service_role;
GRANT ALL ON public.scheduler_service_area_cities TO service_role;
GRANT ALL ON public.scheduler_city_zip_map        TO service_role;
GRANT ALL ON public.scheduler_leads               TO service_role;
GRANT ALL ON public.scheduler_lead_attachments    TO service_role;

GRANT USAGE ON SEQUENCE public.scheduler_lead_seq TO service_role;
GRANT USAGE ON SEQUENCE public.scheduler_lead_seq TO authenticated;

-- ============================================================
-- Default settings seed
-- ============================================================

INSERT INTO public.scheduler_settings (key, value) VALUES
  -- Sync / operational (internal, not exposed to widget)
  ('sync_mode',                    '"manual"'),
  ('auto_sync_area_only',          'true'),
  ('auto_sync_skip_dupes',         'true'),
  ('office_notification_email',    '"office@castlegaragedoors.com"'),
  ('max_upload_files',             '5'),
  ('max_upload_size_mb',           '25'),
  ('file_retention_days',          '30'),
  ('tos_url',                      '"https://castlegaragedoors.com/terms"'),
  -- Scheduling availability (public)
  ('scheduling_enabled',           'true'),
  ('scheduling_disabled_message',  '"Online scheduling is temporarily unavailable. Please call us to schedule your appointment."'),
  ('scheduling_horizon_days',      '14'),
  ('available_days',               '[1,2,3,4,5,6]'),
  ('time_windows',                 '[{"start":"08:00","end":"12:00","label":"8 AM – 12 PM"},{"start":"12:00","end":"16:00","label":"12 PM – 4 PM"}]'),
  -- Incentive banner (public)
  ('incentive_banner_enabled',     'true'),
  ('incentive_banner_text',        '"$50 off your first service"'),
  -- Contact / legal copy (public)
  ('office_phone',                 '"(800) 576-1397"'),
  ('tcpa_copy',                    '"By checking this box, you consent to receive text messages about your appointment from Castle Garage Doors & Gates. Message and data rates may apply. Reply STOP to opt out."'),
  ('marketing_sms_copy',           '"I''d like to receive promotions and tips by SMS."'),
  -- Service categories (public)
  ('garage_door_categories',       '["Repair","Spring Replacement","New Door Installation","Opener Repair","Opener Installation","Cable Replacement","Other"]'),
  ('gate_categories',              '["Repair","Opener Repair","Opener Installation","New Gate Installation","Other"]'),
  ('garage_door_issues',           '["Door won''t open","Door won''t close","Door is noisy","Door is off-track","Broken spring","Broken cable","Remote/keypad not working","Door moves slowly","Other"]'),
  ('gate_issues',                  '["Gate won''t open","Gate won''t close","Gate is noisy","Remote/keypad not working","Gate moves slowly","Other"]')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Default widget instance
-- ============================================================

INSERT INTO public.scheduler_widget_instances (id, display_name, lead_source, api_key, is_active)
VALUES (
  'main_site',
  'Main Website',
  'website',
  encode(gen_random_bytes(32), 'hex'),
  true
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Service area seed — San Diego County + Riverside County
-- ============================================================
-- Pre-populated with incorporated cities and major unincorporated
-- communities. John prunes this list from Settings → Service Area.

INSERT INTO public.scheduler_service_area_cities (city, state) VALUES
  -- San Diego County — Incorporated cities
  ('Carlsbad', 'CA'),
  ('Chula Vista', 'CA'),
  ('Coronado', 'CA'),
  ('Del Mar', 'CA'),
  ('El Cajon', 'CA'),
  ('Encinitas', 'CA'),
  ('Escondido', 'CA'),
  ('Imperial Beach', 'CA'),
  ('La Mesa', 'CA'),
  ('Lemon Grove', 'CA'),
  ('National City', 'CA'),
  ('Oceanside', 'CA'),
  ('Poway', 'CA'),
  ('San Diego', 'CA'),
  ('San Marcos', 'CA'),
  ('Santee', 'CA'),
  ('Solana Beach', 'CA'),
  ('Vista', 'CA'),
  -- San Diego County — Unincorporated communities
  ('Alpine', 'CA'),
  ('Bonita', 'CA'),
  ('Borrego Springs', 'CA'),
  ('Boulevard', 'CA'),
  ('Campo', 'CA'),
  ('Cardiff By The Sea', 'CA'),
  ('Casa de Oro', 'CA'),
  ('Crest', 'CA'),
  ('Descanso', 'CA'),
  ('Dulzura', 'CA'),
  ('El Cajon', 'CA'),
  ('Fallbrook', 'CA'),
  ('Jamul', 'CA'),
  ('Julian', 'CA'),
  ('Lakeside', 'CA'),
  ('Lincoln Acres', 'CA'),
  ('Mount Helix', 'CA'),
  ('Pine Valley', 'CA'),
  ('Potrero', 'CA'),
  ('Ramona', 'CA'),
  ('Rancho San Diego', 'CA'),
  ('Rancho Santa Fe', 'CA'),
  ('Santa Ysabel', 'CA'),
  ('Spring Valley', 'CA'),
  ('Tecate', 'CA'),
  ('Valley Center', 'CA'),
  ('Warner Springs', 'CA'),
  -- Riverside County — Incorporated cities
  ('Banning', 'CA'),
  ('Beaumont', 'CA'),
  ('Blythe', 'CA'),
  ('Calimesa', 'CA'),
  ('Canyon Lake', 'CA'),
  ('Cathedral City', 'CA'),
  ('Coachella', 'CA'),
  ('Corona', 'CA'),
  ('Desert Hot Springs', 'CA'),
  ('Eastvale', 'CA'),
  ('Hemet', 'CA'),
  ('Indian Wells', 'CA'),
  ('Indio', 'CA'),
  ('Jurupa Valley', 'CA'),
  ('La Quinta', 'CA'),
  ('Lake Elsinore', 'CA'),
  ('Menifee', 'CA'),
  ('Moreno Valley', 'CA'),
  ('Murrieta', 'CA'),
  ('Norco', 'CA'),
  ('Palm Desert', 'CA'),
  ('Palm Springs', 'CA'),
  ('Perris', 'CA'),
  ('Rancho Mirage', 'CA'),
  ('Riverside', 'CA'),
  ('San Jacinto', 'CA'),
  ('Temecula', 'CA'),
  ('Wildomar', 'CA'),
  -- Riverside County — Unincorporated communities
  ('Anza', 'CA'),
  ('Bermuda Dunes', 'CA'),
  ('Cherry Valley', 'CA'),
  ('French Valley', 'CA'),
  ('Good Hope', 'CA'),
  ('Home Gardens', 'CA'),
  ('Idyllwild', 'CA'),
  ('Lake Mathews', 'CA'),
  ('Lakeland Village', 'CA'),
  ('Mecca', 'CA'),
  ('Mira Loma', 'CA'),
  ('Mission Grove', 'CA'),
  ('Nuevo', 'CA'),
  ('Romoland', 'CA'),
  ('Rubidoux', 'CA'),
  ('Sky Valley', 'CA'),
  ('Thermal', 'CA'),
  ('Thousand Palms', 'CA'),
  ('Winchester', 'CA'),
  ('Woodcrest', 'CA')
ON CONFLICT (city, state) DO NOTHING;

-- ============================================================
-- City → zip mapping seed
-- ============================================================
-- Primary zip codes per city. Used to derive the zip list shown
-- in Settings and used in the service area check.

INSERT INTO public.scheduler_city_zip_map (city, state, zip) VALUES
  -- San Diego County
  ('Carlsbad', 'CA', '92008'),
  ('Carlsbad', 'CA', '92009'),
  ('Carlsbad', 'CA', '92010'),
  ('Carlsbad', 'CA', '92011'),
  ('Chula Vista', 'CA', '91910'),
  ('Chula Vista', 'CA', '91911'),
  ('Chula Vista', 'CA', '91913'),
  ('Chula Vista', 'CA', '91914'),
  ('Chula Vista', 'CA', '91915'),
  ('Coronado', 'CA', '92118'),
  ('Del Mar', 'CA', '92014'),
  ('El Cajon', 'CA', '92019'),
  ('El Cajon', 'CA', '92020'),
  ('El Cajon', 'CA', '92021'),
  ('Encinitas', 'CA', '92023'),
  ('Encinitas', 'CA', '92024'),
  ('Cardiff By The Sea', 'CA', '92007'),
  ('Escondido', 'CA', '92025'),
  ('Escondido', 'CA', '92026'),
  ('Escondido', 'CA', '92027'),
  ('Escondido', 'CA', '92029'),
  ('Imperial Beach', 'CA', '91932'),
  ('La Mesa', 'CA', '91941'),
  ('La Mesa', 'CA', '91942'),
  ('La Mesa', 'CA', '91943'),
  ('La Mesa', 'CA', '91944'),
  ('Lemon Grove', 'CA', '91945'),
  ('National City', 'CA', '91950'),
  ('Oceanside', 'CA', '92049'),
  ('Oceanside', 'CA', '92051'),
  ('Oceanside', 'CA', '92054'),
  ('Oceanside', 'CA', '92056'),
  ('Oceanside', 'CA', '92057'),
  ('Oceanside', 'CA', '92058'),
  ('Poway', 'CA', '92064'),
  ('San Diego', 'CA', '92101'),
  ('San Diego', 'CA', '92102'),
  ('San Diego', 'CA', '92103'),
  ('San Diego', 'CA', '92104'),
  ('San Diego', 'CA', '92105'),
  ('San Diego', 'CA', '92106'),
  ('San Diego', 'CA', '92107'),
  ('San Diego', 'CA', '92108'),
  ('San Diego', 'CA', '92109'),
  ('San Diego', 'CA', '92110'),
  ('San Diego', 'CA', '92111'),
  ('San Diego', 'CA', '92113'),
  ('San Diego', 'CA', '92114'),
  ('San Diego', 'CA', '92115'),
  ('San Diego', 'CA', '92116'),
  ('San Diego', 'CA', '92117'),
  ('San Diego', 'CA', '92119'),
  ('San Diego', 'CA', '92120'),
  ('San Diego', 'CA', '92121'),
  ('San Diego', 'CA', '92122'),
  ('San Diego', 'CA', '92123'),
  ('San Diego', 'CA', '92124'),
  ('San Diego', 'CA', '92126'),
  ('San Diego', 'CA', '92127'),
  ('San Diego', 'CA', '92128'),
  ('San Diego', 'CA', '92129'),
  ('San Diego', 'CA', '92130'),
  ('San Diego', 'CA', '92131'),
  ('San Diego', 'CA', '92132'),
  ('San Diego', 'CA', '92134'),
  ('San Diego', 'CA', '92139'),
  ('San Diego', 'CA', '92140'),
  ('San Diego', 'CA', '92145'),
  ('San Diego', 'CA', '92147'),
  ('San Diego', 'CA', '92154'),
  ('San Diego', 'CA', '92161'),
  ('San Diego', 'CA', '92173'),
  ('San Marcos', 'CA', '92069'),
  ('San Marcos', 'CA', '92078'),
  ('Santee', 'CA', '92071'),
  ('Solana Beach', 'CA', '92075'),
  ('Vista', 'CA', '92081'),
  ('Vista', 'CA', '92083'),
  ('Vista', 'CA', '92084'),
  ('Vista', 'CA', '92085'),
  -- San Diego County unincorporated
  ('Alpine', 'CA', '91901'),
  ('Bonita', 'CA', '91902'),
  ('Borrego Springs', 'CA', '92004'),
  ('Boulevard', 'CA', '91905'),
  ('Campo', 'CA', '91906'),
  ('Crest', 'CA', '92021'),
  ('Descanso', 'CA', '91916'),
  ('Dulzura', 'CA', '91917'),
  ('Fallbrook', 'CA', '92028'),
  ('Jamul', 'CA', '91935'),
  ('Julian', 'CA', '92036'),
  ('Lakeside', 'CA', '92040'),
  ('Lincoln Acres', 'CA', '91950'),
  ('Mount Helix', 'CA', '91941'),
  ('Casa de Oro', 'CA', '91977'),
  ('Pine Valley', 'CA', '91962'),
  ('Potrero', 'CA', '91963'),
  ('Ramona', 'CA', '92065'),
  ('Rancho San Diego', 'CA', '91978'),
  ('Rancho Santa Fe', 'CA', '92067'),
  ('Santa Ysabel', 'CA', '92070'),
  ('Spring Valley', 'CA', '91977'),
  ('Spring Valley', 'CA', '91978'),
  ('Tecate', 'CA', '91980'),
  ('Valley Center', 'CA', '92082'),
  ('Warner Springs', 'CA', '92086'),
  -- Riverside County incorporated
  ('Banning', 'CA', '92220'),
  ('Beaumont', 'CA', '92223'),
  ('Blythe', 'CA', '92225'),
  ('Calimesa', 'CA', '92320'),
  ('Canyon Lake', 'CA', '92587'),
  ('Cathedral City', 'CA', '92234'),
  ('Coachella', 'CA', '92236'),
  ('Corona', 'CA', '92879'),
  ('Corona', 'CA', '92880'),
  ('Corona', 'CA', '92881'),
  ('Corona', 'CA', '92882'),
  ('Corona', 'CA', '92883'),
  ('Desert Hot Springs', 'CA', '92240'),
  ('Desert Hot Springs', 'CA', '92241'),
  ('Eastvale', 'CA', '91752'),
  ('Hemet', 'CA', '92543'),
  ('Hemet', 'CA', '92544'),
  ('Hemet', 'CA', '92545'),
  ('Indian Wells', 'CA', '92210'),
  ('Indio', 'CA', '92201'),
  ('Indio', 'CA', '92203'),
  ('Jurupa Valley', 'CA', '92509'),
  ('La Quinta', 'CA', '92247'),
  ('La Quinta', 'CA', '92248'),
  ('La Quinta', 'CA', '92253'),
  ('Lake Elsinore', 'CA', '92530'),
  ('Lake Elsinore', 'CA', '92531'),
  ('Lake Elsinore', 'CA', '92532'),
  ('Menifee', 'CA', '92584'),
  ('Menifee', 'CA', '92585'),
  ('Menifee', 'CA', '92586'),
  ('Menifee', 'CA', '92596'),
  ('Moreno Valley', 'CA', '92551'),
  ('Moreno Valley', 'CA', '92552'),
  ('Moreno Valley', 'CA', '92553'),
  ('Moreno Valley', 'CA', '92555'),
  ('Moreno Valley', 'CA', '92557'),
  ('Murrieta', 'CA', '92562'),
  ('Murrieta', 'CA', '92563'),
  ('Norco', 'CA', '92860'),
  ('Palm Desert', 'CA', '92211'),
  ('Palm Desert', 'CA', '92260'),
  ('Palm Springs', 'CA', '92262'),
  ('Palm Springs', 'CA', '92263'),
  ('Perris', 'CA', '92570'),
  ('Perris', 'CA', '92571'),
  ('Perris', 'CA', '92572'),
  ('Rancho Mirage', 'CA', '92270'),
  ('Riverside', 'CA', '92501'),
  ('Riverside', 'CA', '92503'),
  ('Riverside', 'CA', '92504'),
  ('Riverside', 'CA', '92505'),
  ('Riverside', 'CA', '92506'),
  ('Riverside', 'CA', '92507'),
  ('Riverside', 'CA', '92508'),
  ('San Jacinto', 'CA', '92581'),
  ('San Jacinto', 'CA', '92582'),
  ('San Jacinto', 'CA', '92583'),
  ('Temecula', 'CA', '92589'),
  ('Temecula', 'CA', '92590'),
  ('Temecula', 'CA', '92591'),
  ('Temecula', 'CA', '92592'),
  ('Wildomar', 'CA', '92595'),
  -- Riverside County unincorporated
  ('Anza', 'CA', '92539'),
  ('Bermuda Dunes', 'CA', '92203'),
  ('Cherry Valley', 'CA', '92223'),
  ('French Valley', 'CA', '92596'),
  ('Home Gardens', 'CA', '92880'),
  ('Idyllwild', 'CA', '92549'),
  ('Lake Mathews', 'CA', '92570'),
  ('Lakeland Village', 'CA', '92530'),
  ('Mecca', 'CA', '92254'),
  ('Mira Loma', 'CA', '91752'),
  ('Mission Grove', 'CA', '92508'),
  ('Nuevo', 'CA', '92567'),
  ('Romoland', 'CA', '92585'),
  ('Rubidoux', 'CA', '92509'),
  ('Sky Valley', 'CA', '92241'),
  ('Thermal', 'CA', '92274'),
  ('Thousand Palms', 'CA', '92276'),
  ('Winchester', 'CA', '92596'),
  ('Woodcrest', 'CA', '92504')
ON CONFLICT (city, state, zip) DO NOTHING;
