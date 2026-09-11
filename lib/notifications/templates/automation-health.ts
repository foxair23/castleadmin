import { appUrl } from '@/lib/config/domains'
import type { HealthReport, Transition } from '@/lib/ops/health'

// The two automation-health emails: a red/recovered alert on a state change, and the 7am
// summary. Plain, phone-friendly, one link to the Health page.

const BASE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const DOT: Record<string, string> = { green: '🟢', amber: '🟡', red: '🔴' }
const link = () => `${appUrl()}/admin/ops`

const CONDITION_LABEL: Record<string, string> = {
  extension_silent: 'Extension not reporting', config_off: 'Extension configuration', two_devices: 'Two machines reporting', run_failing: 'Service Fusion runs failing',
  genie_list_stale: 'Genie list crawl stale', clopay_list_stale: 'Clopay list crawl stale', genie_full_missing: 'Genie nightly full crawl', clopay_full_missing: 'Clopay nightly full crawl',
  clopay_docs_stale: 'Clopay document sync', sf_session: 'Service Fusion web session', sf_sync_stale: 'Service Fusion API sync',
}
export function conditionLabel(key: string): string {
  if (CONDITION_LABEL[key]) return CONDITION_LABEL[key]
  if (key.startsWith('login_failed:')) return `Auto-login to ${key.slice(13)} failing`
  if (key.startsWith('crawl_never_finishes:')) return `${key.slice(21)} crawls not finishing`
  if (key.startsWith('queue_stale:')) return `SF ${key.slice(12)} queue stuck`
  return key
}

/** What a person can do about a red condition, when there is anything. */
function advice(key: string): string {
  if (key === 'extension_silent') return 'The office machine is asleep, offline, or Chrome is closed. Nothing can be done remotely; if someone is near it, wake it and open Chrome. The extension resumes on its own.'
  if (key === 'config_off') return 'Turn the flag back on from the Health page (the toggles under Remote control).'
  if (key.startsWith('login_failed:')) return 'The extension retries the sign-in every hour. If it keeps failing, check the saved credentials in the extension Options, or press Re-login on the Health page.'
  if (key.startsWith('queue_stale:')) return 'Items are waiting for the extension to post them into Service Fusion. If the extension is otherwise healthy, press Run now on the Health page.'
  if (key === 'run_failing') return 'The office machine cannot reach Castle Admin or Service Fusion. Check the Health page runs for the error.'
  if (key.endsWith('_full_missing') || key.startsWith('crawl_never_finishes:') || key.endsWith('_list_stale')) return 'Press the crawl button for that portal on the Health page and watch the run land. If it stalls again, the portal itself may be down or changed.'
  return 'See the Health page.'
}

export function renderHealthAlert(alerts: Transition[], report: HealthReport): { subject: string; bodyHtml: string; bodyText: string } {
  const reds = alerts.filter(a => a.kind === 'red'), recs = alerts.filter(a => a.kind === 'recovered')
  const subject = reds.length
    ? `🔴 Automation: ${reds.map(a => conditionLabel(a.condition)).join(', ')}`
    : `🟢 Automation recovered: ${recs.map(a => conditionLabel(a.condition)).join(', ')}`
  const lines = [
    ...reds.map(a => `RED — ${conditionLabel(a.condition)}\n${a.detail}\nWhat to do: ${advice(a.condition)}`),
    ...recs.map(a => `RECOVERED — ${conditionLabel(a.condition)}\n${a.detail}`),
  ]
  const others = report.conditions.filter(c => c.state === 'red' && !alerts.some(a => a.condition === c.key))
  const still = others.length ? `\nStill red (already reported): ${others.map(c => conditionLabel(c.key)).join(', ')}` : ''
  const bodyText = `${lines.join('\n\n')}${still}\n\nHealth page: ${link()}`
  const bodyHtml = `<div style="${BASE}">${lines.map(l => `<p style="font-size:15px;line-height:1.6;white-space:pre-line">${esc(l)}</p>`).join('')}${still ? `<p style="font-size:13px;color:#6b7280">${esc(still.trim())}</p>` : ''}<p style="font-size:14px"><a href="${link()}" style="color:#dc2626">Open the Health page →</a></p></div>`
  return { subject, bodyHtml, bodyText }
}

export interface DigestCounts {
  genie: { crawls: number; done: number; detailed: number }
  clopay: { crawls: number; done: number; detailed: number; docsStored: number }
  sf: { runs: number; failed: number; applied: number; notes: number; lines: number; appointments: number; docs: number }
  logins: { failed: number }
}

export function renderHealthDigest(report: HealthReport, counts: DigestCounts, dateLabel: string): { subject: string; bodyHtml: string; bodyText: string } {
  const state = report.overall === 'green' ? 'all green' : report.overall === 'amber' ? 'needs a look' : 'RED'
  const subject = `${DOT[report.overall]} Automation health — ${dateLabel}: ${state}`
  const cardLines = report.cards.map(c => `${DOT[c.state]} ${c.label}\n${c.lines.map(l => `   ${l}`).join('\n')}`)
  const y = [
    `Genie: ${counts.genie.crawls} crawl(s), ${counts.genie.done} finished, ${counts.genie.detailed} orders detailed`,
    `Clopay: ${counts.clopay.crawls} crawl(s), ${counts.clopay.done} finished, ${counts.clopay.detailed} orders detailed, ${counts.clopay.docsStored} documents stored`,
    `Service Fusion: ${counts.sf.runs} run(s), ${counts.sf.failed} failed · ${counts.sf.applied} payments · ${counts.sf.notes} notes · ${counts.sf.lines} line-item jobs · ${counts.sf.appointments} appointments · ${counts.sf.docs} forms`,
    ...(counts.logins.failed ? [`Auto-login failures: ${counts.logins.failed}`] : []),
  ]
  const notOk = report.checklist.filter(c => !c.ok).map(c => c.label)
  const bodyText = `Automation health — ${dateLabel} (${state})\n\n${cardLines.join('\n\n')}\n\nYesterday:\n${y.map(l => `• ${l}`).join('\n')}${notOk.length ? `\n\nChecklist not complete: ${notOk.join('; ')}` : ''}\n\nHealth page: ${link()}`
  const bodyHtml = `<div style="${BASE}"><p style="font-size:18px;font-weight:700;margin:0 0 12px">${esc(subject)}</p>${cardLines.map(l => `<p style="font-size:14px;line-height:1.5;white-space:pre-line;margin:0 0 10px">${esc(l)}</p>`).join('')}<p style="font-size:14px;font-weight:600;margin:16px 0 4px">Yesterday</p><ul style="font-size:14px;line-height:1.5;margin:0;padding-left:18px">${y.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${notOk.length ? `<p style="font-size:13px;color:#b45309">Checklist not complete: ${esc(notOk.join('; '))}</p>` : ''}<p style="font-size:14px;margin-top:16px"><a href="${link()}" style="color:#dc2626">Open the Health page →</a></p></div>`
  return { subject, bodyHtml, bodyText }
}
