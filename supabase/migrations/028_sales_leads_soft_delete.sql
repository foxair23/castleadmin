-- Soft delete for sales_leads: preserves call logs, notes, and status history
-- when a campaign is unassigned or leads are administratively removed.

ALTER TABLE public.sales_leads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS sales_leads_deleted_at ON public.sales_leads (deleted_at);

-- Update sales rep RLS to exclude soft-deleted leads
DROP POLICY IF EXISTS "sales_select_own_leads" ON public.sales_leads;
CREATE POLICY "sales_select_own_leads" ON public.sales_leads
  FOR SELECT USING (
    public.is_sales()
    AND assigned_to_user_id = auth.uid()
    AND deleted_at IS NULL
  );

DROP POLICY IF EXISTS "sales_update_own_leads" ON public.sales_leads;
CREATE POLICY "sales_update_own_leads" ON public.sales_leads
  FOR UPDATE USING (
    public.is_sales()
    AND assigned_to_user_id = auth.uid()
    AND deleted_at IS NULL
  );

-- Child table RLS: sales reps only see records tied to non-deleted, assigned leads
DROP POLICY IF EXISTS "sales_select_calls_on_own_leads" ON public.sales_calls;
CREATE POLICY "sales_select_calls_on_own_leads" ON public.sales_calls
  FOR SELECT USING (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_calls.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "sales_insert_calls_on_own_leads" ON public.sales_calls;
CREATE POLICY "sales_insert_calls_on_own_leads" ON public.sales_calls
  FOR INSERT WITH CHECK (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_calls.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "sales_select_notes_on_own_leads" ON public.sales_notes;
CREATE POLICY "sales_select_notes_on_own_leads" ON public.sales_notes
  FOR SELECT USING (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_notes.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "sales_insert_notes_on_own_leads" ON public.sales_notes;
CREATE POLICY "sales_insert_notes_on_own_leads" ON public.sales_notes
  FOR INSERT WITH CHECK (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_notes.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "sales_select_history_on_own_leads" ON public.sales_status_history;
CREATE POLICY "sales_select_history_on_own_leads" ON public.sales_status_history
  FOR SELECT USING (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_status_history.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "sales_insert_history_on_own_leads" ON public.sales_status_history;
CREATE POLICY "sales_insert_history_on_own_leads" ON public.sales_status_history
  FOR INSERT WITH CHECK (
    public.is_sales() AND EXISTS (
      SELECT 1 FROM public.sales_leads
      WHERE id = sales_status_history.lead_id
        AND assigned_to_user_id = auth.uid()
        AND deleted_at IS NULL
    )
  );
