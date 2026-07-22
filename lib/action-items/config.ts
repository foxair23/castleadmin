// Action-tracking config for the Action Items tabs. Each action tab has exactly
// ONE action (a single button, no dropdown) and a follow-up cadence: pressing
// the button records who/when and sets follow_up_on = today + days. If the item
// is still unresolved when that date arrives, it shows as "Follow-up due" and
// appears in the daily to-do email. Pure data — imported by client, API, and
// the digest cron.

// Items dated before the acquisition are informational only — no action is
// prompted for them (previous owner's history).
export const ACQUISITION_CUTOFF = '2026-04-24'

export interface ActionTabConfig {
  /** Button label — also the recorded action. */
  button: string
  /** Days until follow-up is due if the item hasn't cleared. */
  days: number
  /** Entity type key (matches action_item_notes usage). */
  entity: string
}

export const ACTION_TAB_CONFIG: Record<string, ActionTabConfig> = {
  'unpaid':          { button: 'Payment Requested', days: 3, entity: 'sf_job' },
  // Distinct entity ('sf_job_revenue', not 'sf_job') so logging "Added Revenue"
  // here doesn't collide with the unpaid/uninvoiced/followup action rows, which
  // a $0 job can also appear on.
  'awaiting-revenue':{ button: 'Added Revenue',     days: 3, entity: 'sf_job_revenue' },
  'uninvoiced':      { button: 'Invoiced',          days: 1, entity: 'sf_job' },
  'estimates':       { button: 'Followed Up',       days: 3, entity: 'sf_estimate' },
  'accepted-no-job': { button: 'Converted',         days: 1, entity: 'sf_estimate' },
  'followup':        { button: 'Followed Up',       days: 3, entity: 'sf_job' },
  'awaiting-sf':     { button: 'Job Created',       days: 1, entity: 'sales_lead' },
}

export interface ActionRecord {
  action_label: string
  actioned_at: string
  actioned_by_name: string | null
  follow_up_on: string // YYYY-MM-DD
}

/** Today's date in the business timezone (America/Los_Angeles), YYYY-MM-DD. */
export function todayPT(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}
