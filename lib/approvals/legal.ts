// Customer Work Authorization — legal text shown on the approval page + email.
//
// ⚠️ PLACEHOLDER CONTENT. Replace the section bodies below with final wording from
// ownership/counsel. When you change the text in any way, bump LEGAL_VERSION —
// that changes the fingerprint, so any not-yet-approved link presents (and records)
// the new version. Already-approved records keep the version they were signed under.
//
// Tokens available inside section bodies (substituted at render time — see
// lib/approvals/acceptance.ts):
//   {{CUSTOMER_NAME}}   {{JOB_NUMBER}}   {{AMOUNT_TOTAL}}
//   {{APPROVED_NAME}}   {{APPROVED_AT}}   {{LEGAL_VERSION}}

export const LEGAL_VERSION = '2026-08-01'

// Document title, shown above the sections on the approval screen and email.
export const LEGAL_TITLE = 'Work Authorization & Approval'

export interface LegalSection {
  heading: string
  body: string
}

export const LEGAL_SECTIONS: LegalSection[] = [
  {
    heading: '1. Authorization to Perform Work',
    body:
      `By approving below, I authorize Castle Garage Inc (dba Castle Garage Doors & Gates) to perform ` +
      `the work listed above at the prices shown, for a total of {{AMOUNT_TOTAL}}.\n\n` +
      `I confirm that I am the customer or an authorized representative of the customer for this job, and ` +
      `that I have the authority to approve this work.`,
  },
  {
    heading: '2. Pricing',
    body:
      `The prices shown are for the listed products and services. Additional work, parts, or conditions ` +
      `discovered during the job that are not listed above may change the final price and will be discussed ` +
      `with me before that additional work is performed.\n\n` +
      `Applicable taxes and fees may apply and may not be reflected in the amount shown.`,
  },
  {
    heading: '3. Payment',
    body:
      `I agree to pay the amount due for the approved work upon completion, unless other written terms have ` +
      `been arranged with Castle Garage Inc.`,
  },
  {
    heading: 'Customer Acknowledgment',
    body:
      `I have reviewed the products and services listed above and I approve this work and its price. I ` +
      `understand that my name, the date and time, and my device details are recorded as my electronic ` +
      `signature. Approval version {{LEGAL_VERSION}}.`,
  },
]
