-- Add locked rate columns to preserve pay rates at the time of job entry
ALTER TABLE public.job_work_items
  ADD COLUMN IF NOT EXISTS job_type_name text,
  ADD COLUMN IF NOT EXISTS locked_base_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS locked_additional_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS locked_requires_quantity boolean;

-- Backfill existing records from current job_types
UPDATE public.job_work_items wi
SET
  job_type_name = jt.name,
  locked_base_rate = jt.base_rate,
  locked_additional_rate = jt.additional_rate,
  locked_requires_quantity = jt.requires_quantity
FROM public.job_types jt
WHERE wi.job_type_id = jt.id;

-- Make job_type_id nullable so deleting a job_type sets it to NULL
-- (preserving the work item with its locked name/rate)
ALTER TABLE public.job_work_items DROP CONSTRAINT IF EXISTS job_work_items_job_type_id_fkey;
ALTER TABLE public.job_work_items ALTER COLUMN job_type_id DROP NOT NULL;
ALTER TABLE public.job_work_items ADD CONSTRAINT job_work_items_job_type_id_fkey
  FOREIGN KEY (job_type_id) REFERENCES public.job_types(id) ON DELETE SET NULL;
