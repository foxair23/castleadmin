export interface CrmTechnician {
  id: string
  name: string
}

export interface CrmJob {
  id: string
  jobNumber: string      // human-readable job number e.g. "10042"
  customerName: string
  scheduledDate: string  // YYYY-MM-DD
  status: 'assigned' | 'completed'
  statusLabel: string    // original status name from the CRM, for display
}

export interface CrmProvider {
  testConnection(): Promise<void>  // throws on failure
  listTechnicians(): Promise<CrmTechnician[]>
  listJobsForTech(sfTechId: string, weekStart: Date, weekEnd: Date): Promise<CrmJob[]>
}
