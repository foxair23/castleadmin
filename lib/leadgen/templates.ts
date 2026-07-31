// Customer-facing copy for lead outreach. Kept in one place so the wording is
// easy to review/adjust.

/** First-touch SMS. `scheduleUrl` e.g. "sfi.cstle.co". */
export function renderLeadSms(scheduleUrl: string): string {
  return `Hi, this is Castle Garage Doors & Gates reaching out regarding your Home Depot service request. We'd like to schedule a visit to inspect the issue with your garage door or opener and review the best service options available.

For Self Scheduling visit ${scheduleUrl}

If you need further assistance reply 1 to request a call back or 2 if you are no longer interested. Thank you.

Reply STOP to opt out.`
}

/** Acknowledgement texts for the 1 / 2 replies. */
export const REPLY_CALLBACK_ACK = 'Thank you — a Castle Garage team member will call you shortly to schedule. Reply STOP to opt out.'
export const REPLY_NOT_INTERESTED_ACK = 'Thank you for letting us know. We\'ve noted you\'re no longer interested and won\'t follow up. Reply STOP to opt out.'
