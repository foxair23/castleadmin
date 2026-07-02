// Commission Agreement — legal text.
//
// ⚠️ PLACEHOLDER CONTENT. Replace the section bodies below with the final wording
// from ownership/counsel. When you change the text in any way, bump LEGAL_VERSION
// (below) — that invalidates every prior acceptance and correctly forces all
// technicians to re-accept the new version.
//
// Tokens available inside section bodies (substituted at render time — see
// lib/commission/acceptance.ts):
//   {{TECH_NAME}}   {{PERIOD}}   {{PERIOD_START}}   {{PERIOD_END}}
//   {{SALES_TARGET}}   {{RATE_BELOW}}   {{RATE_ABOVE}}
//   {{ACCEPTED_NAME}}   {{ACCEPTED_AT}}   {{LEGAL_VERSION}}

export const LEGAL_VERSION = '2026-07-02'

// Document title, shown above the sections on the acceptance screen and email.
export const LEGAL_TITLE = 'Net New Sales Commission Plan'

export interface LegalSection {
  heading: string
  body: string
}

export const LEGAL_SECTIONS: LegalSection[] = [
  {
    heading: '1. Purpose',
    body:
      `This Net New Sales Commission Plan is intended to reward employees for creating new business and ` +
      `generating additional sales for Castle Garage Doors & Gates.\n\n` +
      `This plan is separate from the employee's base compensation, piecework rates, hourly wages, or any ` +
      `other compensation described in the employee's employment agreement.`,
  },
  {
    heading: '2. Eligible Sales',
    body:
      `Employees may earn commission on eligible net new sales that they directly create, source, or close ` +
      `during the Plan Period.\n\n` +
      `For purposes of this plan, "net new sales" generally means new revenue that would not have otherwise ` +
      `been generated without the employee's direct sales effort. Eligible net new sales will typically be ` +
      `new Service Fusion jobs created by the technician or installer.\n\n` +
      `Examples may include:\n` +
      `•  New repair, service, installation, or gate work sold by the employee\n` +
      `•  New customer jobs sourced by the employee\n` +
      `•  Additional approved work sold during a service or installation visit\n` +
      `•  Customer upgrades or add-ons approved by Castle Garage Doors & Gates\n\n` +
      `Castle Garage Doors & Gates will make the final determination as to whether a sale qualifies as ` +
      `eligible net new sales under this plan. To be eligible for commission, the job must have pictures and ` +
      `other required documentation in Service Fusion.`,
  },
  {
    heading: '3. Commission Structure',
    body:
      `For the Plan Period listed above, eligible net new sales will be paid based on the Sales Target and ` +
      `commission rates listed in Your Plan Terms above.\n\n` +
      `The employee will earn the commission Rate up to target on eligible net new sales up to the Sales Target.\n\n` +
      `The employee will earn the commission Rate above target only on eligible net new sales above the Sales Target.`,
  },
  {
    heading: '4. Payment Timing',
    body:
      `Commissions will be calculated after the end of the month and paid through regular payroll, subject to ` +
      `all applicable withholdings and deductions.\n\n` +
      `Commissions are only earned and payable after:\n` +
      `•  The customer has approved the work;\n` +
      `•  The work has been completed, unless otherwise approved by management;\n` +
      `•  Castle Garage Doors & Gates has received payment from the customer; and\n` +
      `•  The sale has been confirmed as eligible under this plan.`,
  },
  {
    heading: '5. Adjustments, Cancellations, and Refunds',
    body:
      `If a customer cancels the job, does not pay, receives a refund, disputes payment, or if the sale is ` +
      `otherwise reversed or adjusted, Castle Garage Doors & Gates may reduce, withhold, or recover the ` +
      `related commission.\n\n` +
      `Commissions may also be adjusted for discounts, credits, callbacks, warranty work, warranty claims, or ` +
      `other reductions to the final amount collected by the company.`,
  },
  {
    heading: '6. Management Approval',
    body:
      `All commissions are subject to review and approval by Castle Garage Doors & Gates management.\n\n` +
      `Castle Garage Doors & Gates reserves the right to determine:\n` +
      `•  Whether a sale qualifies as eligible net new sales;\n` +
      `•  Whether the employee was responsible for generating the sale; and\n` +
      `•  The final commission amount payable.`,
  },
  {
    heading: '7. Plan Changes',
    body:
      `This commission plan applies only to the Plan Period listed above. This plan supersedes and replaces ` +
      `any previous commission plan.\n\n` +
      `Castle Garage Doors & Gates may change, replace, suspend, or discontinue this plan at any time. Future ` +
      `months may have different commission rates, thresholds, eligibility rules, or payment terms.\n\n` +
      `No employee should assume that this plan will continue in the same form after the current plan period.`,
  },
  {
    heading: '8. At-Will Employment',
    body:
      `This plan does not change the employee's at-will employment status. Nothing in this plan guarantees ` +
      `employment, continued participation in a commission plan, or any specific amount of compensation.`,
  },
  {
    heading: 'Employee Acknowledgment',
    body:
      `I acknowledge that I have received and reviewed this Net New Sales Commission Plan. I understand that ` +
      `this plan applies only to the Plan Period listed above and may be changed by Castle Garage Inc in ` +
      `future periods.`,
  },
]
