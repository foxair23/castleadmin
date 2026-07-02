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

export const LEGAL_VERSION = '2026-07-01'

export interface LegalSection {
  heading: string
  body: string
}

export const LEGAL_SECTIONS: LegalSection[] = [
  {
    heading: '1. Overview',
    body:
      `This Commission Agreement ("Agreement") is entered into between Castle Garage Doors & Gates ` +
      `("Company") and {{TECH_NAME}} ("Technician") and governs commission earned for the period ` +
      `{{PERIOD}} ({{PERIOD_START}} through {{PERIOD_END}}).\n\n` +
      `[PLACEHOLDER — final legal language to be provided by ownership/counsel.]`,
  },
  {
    heading: '2. Commission Terms',
    body:
      `For {{PERIOD}}, the sales target is {{SALES_TARGET}}. The Technician earns {{RATE_BELOW}} on ` +
      `collected revenue up to the sales target, and {{RATE_ABOVE}} on collected revenue above the ` +
      `sales target. The sales target and rate tiers are measured against revenue actually received ` +
      `(collected) during the period, not merely work completed.\n\n` +
      `[PLACEHOLDER.]`,
  },
  {
    heading: '3. Payment & Collection',
    body:
      `[PLACEHOLDER — when commission is earned vs. payable, how collection of customer payment ` +
      `affects payout, timing and method of commission payment, treatment of refunds/chargebacks, etc.]`,
  },
  {
    heading: '4. General Terms',
    body:
      `[PLACEHOLDER — at-will nature, right to modify future plans, dispute resolution, governing law, ` +
      `entire-agreement/severability, etc.]`,
  },
  {
    heading: '5. Acknowledgement',
    body:
      `By accepting, the Technician ({{ACCEPTED_NAME}}) acknowledges having read, understood, and agreed ` +
      `to the terms of this Agreement on {{ACCEPTED_AT}}. Agreement version: {{LEGAL_VERSION}}.`,
  },
]
