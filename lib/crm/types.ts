export interface CrmTechnician {
  id: string
  name: string
}

export interface CrmJobItem {
  name: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
}

export interface CrmJob {
  id: string
  jobNumber: string      // human-readable job number e.g. "10042"
  customerName: string
  scheduledDate: string  // YYYY-MM-DD — from the visit's start_date, not the job's
  status: 'assigned' | 'completed'
  statusLabel: string    // original status name from the CRM, for display
  description: string | null
  items: CrmJobItem[]
  visitIndex: number     // 1-based position of this visit within the job
  visitTotal: number     // total number of visits on the job
  visitNotes: string | null  // visit.notes_for_techs
}

export interface CrmProvider {
  testConnection(): Promise<void>  // throws on failure
  listTechnicians(): Promise<CrmTechnician[]>
  listJobsForTech(sfTechId: string, weekStart: Date, weekEnd: Date): Promise<CrmJob[]>
}

// ── Analytics entity shapes returned from SF API ──────────────────────────

export interface SfRawJob {
  id: number | string
  number?: string
  customer_id?: number | string
  customer_name?: string
  category?: string
  status?: string
  created_at?: string
  start_date?: string
  end_date?: string
  closed_at?: string
  total?: number | string
  source?: string
  postal_code?: string
  techs_assigned?: Array<{ id: number | string; name?: string }>
}

export interface SfRawInvoice {
  id: number | string
  job_id?: number | string
  customer_id?: number | string
  created?: string
  due_date?: string
  total?: number | string
  balance?: number | string
  paid_date?: string
}

export interface SfRawEstimate {
  id: number | string
  customer_id?: number | string
  tech_id?: number | string
  status?: string
  created?: string
  accepted_date?: string
  declined_date?: string
  total?: number | string
}

export interface SfRawCustomer {
  id: number | string
  created?: string
  lead_source?: string
  zip?: string
}

export interface SfRawStatus {
  id: number | string
  name: string
  category?: string
}

export interface SfRawCategory {
  id: number | string
  name: string
}

export interface SfPagedResponse<T> {
  items: T[]
  _meta: {
    totalCount: number
    pageCount: number
    currentPage: number
    perPage: number
  }
}

// ── Extended CRM provider interface for analytics ─────────────────────────

export interface AnalyticsCrmProvider extends CrmProvider {
  listJobStatuses(): Promise<SfRawStatus[]>
  listJobCategories(): Promise<SfRawCategory[]>
  listJobsPaged(page: number, perPage: number, filters?: Record<string, string>): Promise<SfPagedResponse<SfRawJob>>
  listInvoicesPaged(page: number, perPage: number, filters?: Record<string, string>): Promise<SfPagedResponse<SfRawInvoice>>
  listEstimatesPaged(page: number, perPage: number, filters?: Record<string, string>): Promise<SfPagedResponse<SfRawEstimate>>
  listCustomersPaged(page: number, perPage: number): Promise<SfPagedResponse<SfRawCustomer>>
}
