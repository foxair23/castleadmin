// Service Fusion automation. Runs in the extension service worker and fetches
// admin.servicefusion.com with the user's session cookies (host_permissions +
// credentials:'include'). Service workers have no DOM, so we parse the returned
// HTML with targeted regexes against known field names.
//
// Flow per line:
//   1. resolveInvoiceId(number)      — global search → hashed invoice web id
//   2. openPaymentForm(id, amount)   — POST /accounting/receiveAPayment → form HTML
//   3. parseForm(html)               — pull hidden ids + invoice total
//   4. (safety) amount must fit the invoice's remaining total
//   5. submitPayment(...)            — POST /saveInvoicePayments  (skipped in dry-run)
//
// Every step pushes to `trace` so a dry-run tells us exactly where it breaks.

const SF = 'https://admin.servicefusion.com'
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&')

async function sfFetch(path, { method = 'GET', body } = {}) {
  // These endpoints are form-POST navigations in the browser (no X-Requested-With);
  // send them the same way so SF returns the form instead of bouncing home.
  const res = await fetch(`${SF}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    body,
  })
  const text = await res.text()
  return { status: res.status, url: res.url, redirected: res.redirected, text }
}

/** Value of a hidden <input name="…"> regardless of attribute order/quoting. */
function inputValue(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tag = html.match(new RegExp(`<input[^>]*\\bname=['"]?${esc}['"]?[^>]*>`, 'i'))
  if (!tag) return null
  const v = tag[0].match(/\bvalue=['"]([^'"]*)['"]/i)
  return v ? v[1] : null
}

/** Resolve an SF invoice NUMBER to its hashed web id via global search. */
export async function resolveInvoiceId(invoiceNumber, trace) {
  const r = await sfFetch('/serviceSpot/loadGlobalSearchResults', { method: 'POST', body: form({ string: invoiceNumber }) })
  trace.push({ step: 'search', status: r.status })
  let data
  try { data = JSON.parse(r.text) } catch { throw new Error('global search did not return JSON (session expired?)') }
  const results = data.results || data || []
  // Prefer an Invoices result whose label contains the number.
  const inv = results.find(x => /invoice/i.test(x.type || x.category || '') && String(x.label || x.name || x.customerNameChain || '').includes(invoiceNumber))
    || results.find(x => /invoice/i.test(x.type || x.category || ''))
  if (!inv || !inv.value && !inv.id) throw new Error(`invoice #${invoiceNumber} not found in global search`)
  return inv.value || inv.id
}

/** The invoice's customer (hashed web id), read off the invoice page. SF's
 *  receive-payment form POST requires it; without it SF bounces to the home page. */
export async function resolveCustomerId(invoiceId, trace) {
  const r = await sfFetch(`/viewInvoice?id=${encodeURIComponent(invoiceId)}`)
  trace.push({ step: 'viewInvoice', status: r.status, len: r.text.length })
  // Try a hidden field first, then a customer link / JSON, all hashed-id shaped.
  const id =
    inputValue(r.text, 'customerId') ||
    (r.text.match(/customerId=([A-Za-z0-9_-]{20,})/)?.[1] ?? null) ||
    (r.text.match(/customer(?:View|Detail)s?\?id=([A-Za-z0-9_-]{20,})/i)?.[1] ?? null) ||
    (r.text.match(/["']customerId["']\s*:\s*["']([A-Za-z0-9_-]{20,})["']/)?.[1] ?? null)
  if (!id) throw new Error(`could not find customerId on viewInvoice for ${invoiceId} (status ${r.status}, ${r.text.length}b)`)
  return id
}

/** POST the receive-payment form for an invoice; returns the form HTML. */
export async function openPaymentForm(invoiceId, amount, trace) {
  const customerId = await resolveCustomerId(invoiceId, trace)
  trace.push({ step: 'customerId', customerId })
  const r = await sfFetch('/accounting/receiveAPayment', {
    method: 'POST',
    body: form({ customerId, 'invoiceIds[]': invoiceId, 'invoice[paymentsSelected]': amount }),
  })
  trace.push({ step: 'openForm', status: r.status, len: r.text.length, url: r.url })
  if (!/id=["']?form-payment-transaction/.test(r.text)) {
    // Login is judged by WHERE it landed (redirect URL), not page text — the SF
    // app shell contains "login"/"password" strings and was giving false positives.
    const looksLogin = /login|signin|customlogin/i.test(r.url)
    // Name the page SF bounced us to, so we can tell a rejected request (→ home /
    // dispatch) from a genuine login redirect or a changed form.
    const landed = r.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    throw new Error(`receiveAPayment: no payment form (status ${r.status}, ${r.text.length}b, invoiceId "${invoiceId}", landed ${landed}, login?${looksLogin})`)
  }
  return r.text
}

/** Pull the ids + totals we need to submit. */
export function parseForm(html) {
  const customerId = inputValue(html, 'invoice[customerId1234]')
    || (html.match(/name=invoice\[customerId\]>\s*<option value="([^"]+)"/i)?.[1] ?? null)
  const invoiceId = inputValue(html, 'invoice[0][id]')
  const jobs = inputValue(html, 'invoice[0][jobs]')
  const invoiceTotalORG = inputValue(html, 'invoice[0][invoiceTotalORG]')
  const invoiceTotal = inputValue(html, 'invoice[0][invoiceTotal]')
  const isRecurring = inputValue(html, 'invoice[0][is_recurring]') ?? '0'
  const gateway = inputValue(html, 'Payment[paymentGateway]') || (html.match(/id="defaultGtwy"\s+value="([^"]+)"/)?.[1] ?? '298495691')
  return { customerId, invoiceId, jobs, invoiceTotalORG, invoiceTotal, isRecurring, gateway }
}

/** Build + POST the payment. Returns { ok, paymentId, url }. */
export async function submitPayment(parsed, item, cfg, trace) {
  const amount = Number(item.amount).toFixed(2)
  const owedAfter = (Number(parsed.invoiceTotal) - Number(item.amount)).toFixed(2)
  const body = form({
    'invoice[customerId]': parsed.customerId,
    'Payment[paymentType]': item.paymentTypeId,
    'Payment[pay-type]': item.payType,
    'Payment[cardCategory]': 'existing',
    'Payment[last_four]': '0',
    'Payment[cc_exp_date]': '',
    'Payment[cvc]': '',
    'Payment[billing_street_number]': '',
    'Payment[billing_postal_code]': '',
    'Payment[reference_number]': item.reference || '',
    'Payment[received_by]': cfg.receivedBy || '',
    'Payment[received_on]': item.receivedOn || '',
    'Payment[memo]': item.memo || '',
    'Payment[amount]': amount,
    'Payment[paymentGateway]': parsed.gateway,
    'Payment[authorization_code]': '',
    'Payment[transaction_id]': '',
    'invoice[customerId1234]': parsed.customerId,
    'invoice[0][id]': parsed.invoiceId,
    'invoice[0][is_recurring]': parsed.isRecurring,
    'invoice[0][jobs]': parsed.jobs,
    'invoice[0][invoiceTotalORG]': parsed.invoiceTotalORG,
    'invoice[0][invoiceTotal]': parsed.invoiceTotal,
    'invoice[0][applyTotal]': amount,
    'invoice[amountOfPayment]': amount,
    'invoice[paymentApplied]': amount,
    'invoice[owedAfterPayment]': owedAfter,
  })

  if (cfg.dryRun) {
    trace.push({ step: 'submit', dryRun: true, wouldPost: '/saveInvoicePayments', amount, invoiceId: parsed.invoiceId })
    return { ok: true, dryRun: true, paymentId: null }
  }

  const r = await sfFetch('/saveInvoicePayments', { method: 'POST', body })
  trace.push({ step: 'submit', status: r.status, url: r.url })
  const ok = /viewPayment/i.test(r.url) || /Transaction Successfull/i.test(r.text)
  if (!ok) throw new Error('saveInvoicePayments did not confirm success')
  const paymentId = r.url.match(/viewPayment\?id=([^&]+)/)?.[1] ?? null
  return { ok: true, paymentId, url: r.url }
}

/** Full flow for one queued line. Returns { ok, dryRun?, paymentId?, error?, trace }. */
export async function applyOne(item, cfg) {
  const trace = []
  try {
    const invoiceId = await resolveInvoiceId(item.invoiceNumber, trace)
    const html = await openPaymentForm(invoiceId, item.amount, trace)
    const parsed = parseForm(html)
    trace.push({ step: 'parse', ...parsed })
    if (!parsed.customerId || !parsed.invoiceId || !parsed.jobs) throw new Error('could not parse required ids from the form')
    if (parsed.invoiceId !== invoiceId) throw new Error('form invoice id does not match the resolved invoice')
    // Safety: never apply more than the invoice's remaining total (guards against
    // a duplicate/already-paid invoice).
    if (Number(item.amount) > Number(parsed.invoiceTotal) + 0.01) {
      throw new Error(`amount ${item.amount} exceeds invoice remaining ${parsed.invoiceTotal} — skipped (possible existing payment)`)
    }
    const res = await submitPayment(parsed, item, cfg, trace)
    return { ok: true, dryRun: res.dryRun || false, paymentId: res.paymentId, trace }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), trace }
  }
}
