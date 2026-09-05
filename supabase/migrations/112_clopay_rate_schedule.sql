-- Clopay's agreed labor rate schedule (Exhibit B), and the per-line variance it exposes.
--
-- The IPO tells us what Clopay is PAYING for each line; this table is what they AGREED to
-- pay. Comparing them catches underpayment we would otherwise only find by reading PDFs.
--
-- Two things make the comparison non-obvious, and both are load-bearing:
--   1. The IPO prints a LINE TOTAL while the schedule is a UNIT rate, so the comparison is
--      line_fee / quantity. Skipping that made FIR930 (qty 4, $600) look like a $446
--      discrepancy instead of the real $4.
--   2. Only labor codes are in the schedule. An IPO also carries doors, openers and parts
--      (DC13, 3553061, 0650792 …) at $0.00, which have no agreed rate and are not variances.
--
-- Seeded from "Castle_Garage_Door_CA_54923_62926.xls" — Residential tab effective 2026-06-29
-- ("$4.00 adjustment on singles doubles, GDO and home delivery"). A later schedule replaces
-- these rows by code.

create table if not exists public.clopay_rate_schedule (
  code           text primary key,          -- FIC/FIR code, as printed on the IPO
  schedule       text not null,             -- 'residential' | 'commercial'
  rate           numeric(12,2) not null,    -- agreed UNIT rate
  description    text,
  effective_from date,
  updated_at     timestamptz not null default now()
);

comment on table public.clopay_rate_schedule is
  'Clopay''s agreed labor rates (Exhibit B). Compared against each IPO line''s unit fee (line_fee / quantity) to surface underpayment.';

insert into public.clopay_rate_schedule (code, schedule, rate, description) values
('FIR010', 'residential', 342.0, 'Classic Steel Residential - Single Wide'),
  ('FIR011', 'residential', 357.0, 'Classic Steel Residential - Single Wide (Windcode). Relative to the WC requirements in the specific wind speed zone'),
  ('FIR012', 'residential', 513.0, 'Classic Steel Residential - Single Wide - Extended Height'),
  ('FIR013', 'residential', 533.0, 'Classic Steel Residential - Single Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR020', 'residential', 416.0, 'Classic Steel Residential - Double Wide'),
  ('FIR021', 'residential', 431.0, 'Classic Steel Residential - Double Wide (Windcode) Relative to the WC requirements in the specific wind speed zone'),
  ('FIR022', 'residential', 624.0, 'Classic Steel Residential - Double Wide - Extended Height'),
  ('FIR023', 'residential', 644.0, 'Classic Steel Residential - Double Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR960', 'residential', 342.0, 'Gallery Residential - Single Wide'),
  ('FIR961', 'residential', 357.0, 'Gallery Residential - Single Wide (Windcode) Relative to the WC requirements in the specific wind speed zone'),
  ('FIR962', 'residential', 513.0, 'Gallery Residential - Single Wide - Extended Height'),
  ('FIR963', 'residential', 533.0, 'Gallery Residential - Single Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR965', 'residential', 416.0, 'Gallery Residential - Double Wide'),
  ('FIR966', 'residential', 431.0, 'Gallery Residential - Double Wide (Windcode) Relative to the WC requirements in the specific wind speed zone'),
  ('FIR967', 'residential', 425.0, 'Gallery Residential - Double Wide - Extended Height'),
  ('FIR968', 'residential', 644.0, 'Gallery Residential - Double Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR530', 'residential', 394.0, 'Coachman Residential - Single Wide'),
  ('FIR531', 'residential', 409.0, 'Coachman Residential - Single Wide (Windcode) Relative to the WC requirements in the specific wind speed zone'),
  ('FIR532', 'residential', 591.0, 'Coachman Residential - Single Wide - Extended Height'),
  ('FIR533', 'residential', 611.0, 'Coachman Residential - Single Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR540', 'residential', 569.0, 'Coachman Residential - Double Wide'),
  ('FIR541', 'residential', 584.0, 'Coachman Residential - Double Wide (Windcode) Relative to the WC requirements in the specific wind speed zone'),
  ('FIR542', 'residential', 782.38, 'Coachman Residential - Double Wide - Extended Height'),
  ('FIR543', 'residential', 802.38, 'Coachman Residential - Double Wide (Windcode) - Extended Height Relative to the WC requirements'),
  ('FIR510', 'residential', 676.0, 'Reserve / Avante / Canyon Ridge Collection Residential - Single Wide'),
  ('FIR511', 'residential', 691.0, 'Reserve/Avante/Can Ridge Residential - Single Wide (Windcode)Relative to the WC requirements'),
  ('FIR512', 'residential', 690.0, 'Reserve / Avante / Canyon Ridge Collection Residential - Single Wide - Extended Height'),
  ('FIR513', 'residential', 713.0, 'Reserve/Avante/Can Ridge Residential - Single Wide(Windcode) - Extd Height Relative to the WC requirements'),
  ('FIR520', 'residential', 974.0, 'Reserve / Avante / Canyon Ridge Collection Residential - Double Wide'),
  ('FIR521', 'residential', 995.0, 'Reserve/Avante/Can Ridge Residential - Double Wide (Windcode)Relative to the WC requirements'),
  ('FIR522', 'residential', 1039.0, 'Reserve / Avante / Canyon Ridge Collection Residential - Double Wide - Extended Height'),
  ('FIR523', 'residential', 1194.0, 'Reserve/Avante/Can Ridge Residential - Double Wide(Windcode) - Extd Height Relative to the WC requirements'),
  ('FIR940', 'residential', 205.0, 'Basic Installation of New Construction/Tuff Shed - Single'),
  ('FIR950', 'residential', 245.0, 'Basic Installation of New Construction/Tuff Shed - Double'),
  ('FIR905', 'residential', 1604.0, 'Vertistack Steel Residential - Single Wide'),
  ('FIR907', 'residential', 2304.0, 'Vertistack Steel Residential - Double Wide'),
  ('FIR270', 'residential', 124.0, 'GDO Install w/door up to 8'' high - Customer Supplied Model Purchased from THD (Non-Brand Specific)'),
  ('FIR490', 'residential', 144.0, 'GDO Only Installation up to 8'' high - Chamberlain F&I - Clopay supplied operator installed without a new door install'),
  ('FIR500', 'residential', 124.0, 'GDO Install with door up to 8'' high - Liftmaster products supplied by Clopay and installed with a new door'),
  ('FIR076', 'residential', 144.0, 'Installation of on-site Ceiling Mount GDO ( I program) * residential heights'),
  ('FIR078', 'residential', 189.0, 'Installation of on-site Wall Mount on residential doors up to 12'' high ( I program)'),
  ('FIR1062', 'residential', 129.0, 'GDO Install with a door up to 8'' high - Clopay supplied Chamberlain operator installed with a new door install'),
  ('FIR079', 'residential', 144.0, 'GDO Basic Install - THD "I" program labor only to install GDO on existing door - supplied by customer from THD floor stock'),
  ('FIR770', 'residential', 164.0, 'Residential Trolley GDO Install up to 12'' high w/Residential Extended Height Door (Residential Model Openers)'),
  ('FIR072', 'residential', 189.0, 'Residential jackshaft operator Install on standard height or extended height residential doors up to 12'' high'),
  ('FIR570', 'residential', 35.0, 'GDO Hangers - Material & Labor to install new steel angle mounting brackets where full replacement is needed.'),
  ('FIR460', 'residential', 50.0, 'GDO Reposition - Labor to reposition existing garage door opener during the installation of the new door'),
  ('FIR100', 'residential', 85.0, 'Dead Trip Fee (Door) - Payment for any scheduled service that is canceled beyond the installer''s control that requires a return trip'),
  ('FIR331', 'residential', 85.0, 'Service Trip Charge - Payment for minor service or inspection of jobs within one-year warranty period as requested by Clopay/THD'),
  ('FIR660', 'residential', 85.0, 'Dead Trip Fee (GDO) - Payment for any scheduled service that is canceled beyond the installer''s control that requires a return trip'),
  ('FIR1008', 'residential', 110.0, 'Service Call - Labor paid to installer for standard service call relative to installation outside of the defined one yr installation warranty or for'),
  ('FIR1004', 'residential', 0.0, 'Material & labor to install stop molding on Colonial/Dutch corners'),
  ('FIR550', 'residential', 15.0, 'Decorative Hardware - Labor to install optional decorative hardware on all doors where decorative hardware is sold.'),
  ('FIR080', 'residential', 60.0, 'Rear Track Hangers - Material & labor to install new steel angle mounting brackets for horizontal tracks exceeding 3 feet of headroom'),
  ('FIR260', 'residential', 25.0, 'Bottom Weather Seal - Labor to replace bottom bulb or "U" shaped weather seal (while on site of original install)'),
  ('FIR330', 'residential', 40.0, 'Mileage 31-50 miles - Mapped from originating store. Paid for documented mileage between 31-50 miles from the store. One time-one way fee'),
  ('FIR340', 'residential', 3.0, 'Mileage 51+ miles - Mapped from originating store. Fee paid to installer for mileage in excess of 50 miles. Paid per mile starting at mile 50.'),
  ('FIR280', 'residential', 18.0, 'Quick Turn Brackets - Material & Labor to install quick turn brackets in conjunction with the GDO F&I program (Installer provides material)'),
  ('FIR250', 'residential', 15.0, 'GDO Outside Disconnect - Labor to install outside keyed release / disconnect on doors where there is no other entry into the garage'),
  ('FIR325', 'residential', 40.0, 'Intermediate Section Replacement All Residential & Extended Height Residential- Single Wide'),
  ('FIR326', 'residential', 50.0, 'Intermediate Section Replacement All Residential & Extended Height Residential - Double Wide'),
  ('FIR321', 'residential', 40.0, 'Bottom Section Replacement All Residential & Extended Height Residential - Single Wide'),
  ('FIR322', 'residential', 50.0, 'Bottom Section Replacement All Residential & Extended Height Residential - Double Wide'),
  ('FIR329', 'residential', 45.0, 'Replace Glass - Labor to replace glass on doors with windows that have 2-piece replaceable window frames (paid per section, not paid per window)'),
  ('FIR390', 'residential', 85.0, 'Measure Door - Pre meaure per store request prior to sale of complete job. Will be deducted from basic labor if sale is completed at store.'),
  ('FIR1052', 'residential', 90.0, 'Labor to replace GDO head & rail. Low voltage wiring and photo eyes to remain in place.'),
  ('FIR800', 'residential', 104.0, 'Residential Delivery - Single Wide Door up to 8'' high. Delivery to retail customer for DIY purchases'),
  ('FIR670', 'residential', 104.0, 'Residential Delivery - Double Wide Door up to 8'' high. Delivery to retail customer for DIY purchases'),
  ('FIR920', 'residential', 154.0, 'Extended Height Delivery - Single Wide Door over 8'' high up to 12'' high. Delivery to retail customer for DIY purchases'),
  ('FIR930', 'residential', 154.0, 'Extended Height Delivery - Double Wide Door over 8'' high up to 12'' high. Delivery to retail customer for DIY purchases'),
  ('FIC730', 'residential', 129.0, 'Commercial Delivery - Single Wide Door up to 8'' high. Delivery to retail customer for DIY purchase'),
  ('FIC735', 'residential', 129.0, 'Commercial Delivery - Double Wide Door up to 8'' high. Delivery to retail customer for DIY purchase'),
  ('FIC745', 'residential', 129.0, 'Commercial Delivery - Single Wide Door over 8'' high up to 12'' high. Delivery to retail customer for DIY purchase'),
  ('FIC755', 'residential', 154.0, 'Commercial Delivery - Double Wide Door over 8'' high up to 12'' high. Delivery to retail customer for DIY purchase'),
  ('FIC1074', 'residential', 104.0, 'Replacement Section Delivery - All Door Types. All Secion Sizes'),
  ('FIC1018', 'commercial', 230.0, 'Commercial Sectional Door Model - Single Wide up to 8'' high with standard track configuraton'),
  ('FIC1076', 'commercial', 245.0, 'Commercial Sectional Door Model - Single Wide up to 8'' high with standard track configuraton - WINDCODE -'),
  ('FIC1020', 'commercial', 290.0, 'Commercial Sectional Door Model - Double Wide up to 8'' high with standard track configuraton'),
  ('FIC1078', 'commercial', 310.0, 'Commercial Sectional Door Model - Double Wide up to 8'' high with standard track configuraton - WINDCODE - Relative to the WC requirements in the specific wind speed zone'),
  ('FIC1022', 'commercial', 320.0, 'Commercial Sectional Door Model - Single Wide over 8'' up to 12'' high with standard track configuraton'),
  ('FIC1080', 'commercial', 335.0, 'Commercial Sectional Door Model - Single Wide over 8'' up to 12'' high with standard track configuration - WINDCODE'),
  ('FIC1024', 'commercial', 405.0, 'Commercial Sectional Door Model - Double Wide over 8'' up to 12'' high with standard track configuraton'),
  ('FIC1046', 'commercial', 425.0, 'Commercial Sectional Door Model - Double Wide over 8'' up to 12'' high with standard track configuration - WINDCODE'),
  ('FIR323', 'commercial', 40.0, 'Bottom Section Replacement Commercial - Single Wide'),
  ('FIR324', 'commercial', 50.0, 'Bottom Section Replacement Commercial - Double Wide'),
  ('FIR327', 'commercial', 35.0, 'Intermediate Section Replacement Commercial - Single Wide'),
  ('FIR328', 'commercial', 45.0, 'Intermediate Section Replacement Commercial - Double Wide'),
  ('FIC1008', 'commercial', 52.0, 'Service Call - Specific labor paid to installer for standard service call relative to installation outside of the defined one yr installation warranty or for service on products in')
on conflict (code) do update
  set schedule = excluded.schedule, rate = excluded.rate,
      description = excluded.description, updated_at = now();

update public.clopay_rate_schedule set effective_from = date '2026-06-29' where schedule = 'residential';

alter table public.clopay_rate_schedule enable row level security;
drop policy if exists admin_all_clopay_rate_schedule on public.clopay_rate_schedule;
create policy admin_all_clopay_rate_schedule on public.clopay_rate_schedule for all
  using (public.is_admin()) with check (public.is_admin());

-- Per-line variance, stored so the UI and the daily digest read one number rather than
-- recomputing a join every time.
alter table public.vendor_order_line_items
  add column if not exists schedule_rate numeric(12,2),   -- the agreed unit rate, when the code has one
  add column if not exists unit_fee      numeric(12,2),   -- line_fee / quantity
  add column if not exists rate_variance numeric(12,2);   -- unit_fee - schedule_rate (negative = underpaid)

comment on column public.vendor_order_line_items.rate_variance is
  'unit_fee - schedule_rate. Negative means Clopay paid less than the agreed rate. Null when the code has no agreed rate (doors, openers, parts).';

create index if not exists idx_vendor_order_line_items_variance
  on public.vendor_order_line_items (rate_variance) where rate_variance is not null;

-- Backfill every line already parsed.
update public.vendor_order_line_items l
   set unit_fee      = round(l.line_fee / greatest(coalesce(l.quantity, 1), 1), 2),
       schedule_rate = s.rate,
       rate_variance = round(l.line_fee / greatest(coalesce(l.quantity, 1), 1), 2) - s.rate
  from public.clopay_rate_schedule s
 where upper(trim(l.item_number)) = s.code;

-- Lines whose code has no agreed rate still get their unit fee, so the UI never has to
-- divide again; variance stays null because there is nothing to compare against.
update public.vendor_order_line_items
   set unit_fee = round(line_fee / greatest(coalesce(quantity, 1), 1), 2)
 where unit_fee is null;

-- The daily rate-variance digest. Nobody is auto-subscribed; recipients are chosen in the
-- Notifications tab, so the alert goes to whoever is actually working the Clopay relationship.
insert into public.notification_types
  (key, display_name, description, category, default_for_roles, default_for_dispatch)
values (
  'clopay_rate_mismatch',
  'Clopay Rate Mismatch',
  'A daily summary of Clopay IPO line items paid at something other than the agreed labor rate (Exhibit B), grouped by code with the number of orders and total dollars affected — so a systematic gap reads as one line rather than hundreds of alerts.',
  'operations',
  array[]::text[],
  false
)
on conflict (key) do nothing;
