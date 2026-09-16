-- The technician's mobile number, kept HERE rather than read from Service Fusion.
--
-- E-sign texts the tech their signing link, and the number came from sf_techs.phone_1 /
-- phone_2 — whatever happened to be on their Service Fusion record. That is a field nobody
-- at Castle curates for this purpose, so a wrong or missing number meant either a text to
-- the wrong place or no link at all.
--
-- profiles.sf_technician_id already ties a Castle profile to its SF technician, so this is
-- the number to prefer wherever we contact a tech directly.
alter table public.profiles
  add column if not exists mobile_phone text;

comment on column public.profiles.mobile_phone is
  'Mobile for direct contact (e-sign signing links). Preferred over the Service Fusion tech record.';
