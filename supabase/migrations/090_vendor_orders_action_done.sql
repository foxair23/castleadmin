-- Action-item "Done" state for the Genie tab. A row appears in Action Items when
-- our service creates an SF job from a Genie order (sf_created_job_number set);
-- pressing Done stamps action_done_at and clears it from the tab.
alter table public.vendor_orders add column if not exists action_done_at timestamptz;
alter table public.vendor_orders add column if not exists action_done_by text;
