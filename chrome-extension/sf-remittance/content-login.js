// Content script — LOGIN pages for the portals we automate (Genie / Home Depot,
// Service Fusion, Castle Admin). A scheduled crawl or an expired session lands
// here; we sign back in so automation keeps running unattended.
//
// Why we type the credentials in ourselves instead of leaning on Chrome autofill:
// Chrome deliberately WON'T let a script submit its own autofilled password
// (anti-phishing) — the value is withheld from any submit that isn't a genuine
// user gesture, so an auto-submit sends a blank password ("incorrect password").
// So when the matching credentials are saved on the Options page we set the
// fields directly (via the native setter, so React-based forms register it) and
// submit. With no saved credentials we fall back to nudging Chrome's autofill,
// and if that doesn't take we flag the background to badge + email for a manual
// login. A per-tab guard prevents a submit loop when the credentials don't work.

(() => {
  const LOG = (...a) => console.log('[login]', ...a)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // hostname → which saved credentials to use + which alert the background fires.
  // `company` is set for sites whose login also asks for a Company ID / account
  // (Service Fusion) — filled into a field matched by name/placeholder.
  const SITES = [
    { host: /(^|\.)install\.openings\.net$/, user: 'genieUser', pass: 'geniePass', label: 'Genie', flag: 'genie-login-detected' },
    // Clopay's login lives on the identity provider prod-iam.clopay.com (the
    // portal at hdprogram.clopay.com bounces there via cca.clopay.com), so match
    // the whole clopay.com domain — the driver only acts when a password field is
    // actually present, so it's a no-op on the dashboard/order pages.
    { host: /(^|\.)clopay\.com$/, user: 'clopayUser', pass: 'clopayPass', label: 'Clopay', flag: 'clopay-login-detected' },
    { host: /(^|\.)servicefusion\.com$/, user: 'sfUser', pass: 'sfPass', company: 'sfCompany', label: 'Service Fusion', flag: 'sf-login-detected' },
    { host: /(^|\.)castlegarage(doors)?\.com$/, user: 'castleUser', pass: 'castlePass', label: 'Castle Admin', flag: 'castle-login-detected' },
  ]
  const site = SITES.find(s => s.host.test(location.hostname))
  if (!site) return

  const flag = () => { try { chrome.runtime.sendMessage({ type: site.flag, url: location.href }) } catch { /* ignore */ } }
  const triedKey = `login-tried-${site.label}`

  function realClick(el) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    }
  }
  function pressEnter(el) {
    el.focus()
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }))
    }
  }
  const visible = (el) => el && el.offsetParent !== null

  // Clopay signs in through an OIDC handoff: prod-iam.clopay.com (the actual
  // login) → cca.clopay.com/signin-oidc → the app. Two things stall it
  // unattended: (1) an intermediate page whose self-submitting form didn't fire,
  // and (2) a briefly-blank callback page that just needs the request re-issued
  // ("re-hit enter"). These nudge it along — but ONLY on the auth hosts
  // (prod-iam / cca), never on the app (hdprogram) where clicking a stray button
  // or submitting the search form would interfere with the orders grid.
  // Only prod-iam here — content-clopay owns cca.clopay.com (its blank /login
  // reload + the HD Program tile), so we don't double-drive that page.
  const isClopayAuthHost = /(^|\.)prod-iam\.clopay\.com$/.test(location.hostname)
  function oidcContinue() {
    const form = [...document.forms].find(f =>
      /signin-oidc|connect\/authorize|callback|oidc/i.test(f.getAttribute('action') || '') ||
      f.querySelector('input[name="code" i], input[name="id_token" i], input[name="state" i], input[name="session_state" i], input[name="scope" i]'))
    if (form) { LOG('Clopay OIDC form found — submitting'); try { form.requestSubmit ? form.requestSubmit() : form.submit() } catch { try { form.submit() } catch { /* ignore */ } } return true }
    const btn = [...document.querySelectorAll('button, input[type="submit"], a.btn, .btn, a')]
      .find(el => visible(el) && /continue|proceed|submit|next|sign ?in|authorize|allow/i.test(`${el.innerText || ''} ${el.value || ''}`))
    if (btn) { LOG('Clopay OIDC continue button — clicking'); realClick(btn); return true }
    return false
  }
  // A truly blank callback hop → one reload re-issues the request. Guarded so it
  // never loops (sessionStorage survives the reload on the same origin).
  function recoverBlankOidc() {
    const text = (document.body?.innerText || '').trim()
    if (text.length < 20 && document.forms.length === 0 && !document.querySelector('input')) {
      if (!sessionStorage.getItem('clopay-oidc-reloaded')) {
        sessionStorage.setItem('clopay-oidc-reloaded', '1')
        LOG('blank Clopay OIDC page — reloading once to continue the handoff')
        setTimeout(() => location.reload(), 1200)
      }
    }
  }

  const findSubmit = () =>
    [...document.querySelectorAll('input[type="submit"], button[type="submit"], button, input[type="button"], a.btn, .btn')]
      .find(el => visible(el) && /log ?in|sign ?in|submit|continue|next/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''} ${el.name || ''}`))
    || [...document.querySelectorAll('input[type="submit"], button[type="submit"], button')].find(visible)

  // The Company ID / account / subdomain field, if this login has one. Matched by
  // its name/id/placeholder/label so we don't depend on exact markup.
  const companyField = () => [...document.querySelectorAll('input')].find((el) => {
    if (!visible(el) || el.type === 'password') return false
    const hay = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase()
    return /company|account|subdomain|tenant|organization|\bcompanyid\b/.test(hay)
  })

  // The username/email field — skip the company field if we've already matched it.
  const userField = (exclude) =>
    [...document.querySelectorAll('input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[type="text"]')]
      .find(el => el !== exclude && visible(el))

  // Set a field's value the way the browser would, so React/controlled inputs
  // (Castle Admin) actually register it — a bare `el.value = …` doesn't.
  function setValue(el, val) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } catch { el.value = val }
  }

  async function submitForm(pw) {
    const form = pw.form
    // Autofilled fields the user never touched trip native "please fill out this
    // field" validation; we've set real values, but disable it to be safe.
    if (form) { try { form.noValidate = true } catch { /* ignore */ } }
    const btn = findSubmit()
    if (btn) realClick(btn)
    await sleep(1600)
    if (!document.querySelector('input[type="password"]')) return true // navigated away ⇒ logged in
    pressEnter(pw)
    await sleep(1600)
    if (form) { try { form.requestSubmit ? form.requestSubmit() : form.submit() } catch { try { form.submit() } catch { /* ignore */ } } }
    await sleep(1800)
    return !document.querySelector('input[type="password"]')
  }

  // We have saved credentials → type them in ourselves and submit.
  async function loginWithCreds(pw, u, p, comp) {
    sessionStorage.setItem(triedKey, '1')
    LOG(site.label, '— signing in with saved credentials')
    const company = site.company ? companyField() : null
    if (company && comp) setValue(company, comp)
    const user = userField(company)
    if (user && u) setValue(user, u)
    setValue(pw, p)
    const ok = await submitForm(pw)
    if (!ok) { LOG('saved-credential login did not take — flagging for manual login'); flag() }
  }

  // No saved credentials → coax Chrome's autofill and submit; if the (masked)
  // password won't go through, hand off to manual.
  async function loginWithAutofill(pw) {
    sessionStorage.setItem(triedKey, '1')
    LOG(site.label, '— no saved credentials, trying Chrome autofill')
    const user = userField()
    if (user) { user.focus(); user.click && user.click() }
    if (pw) pw.focus()
    if (user) user.focus()
    await sleep(1200)
    const ok = await submitForm(pw)
    if (!ok) { LOG('autofill login did not take — flagging for manual login'); flag() }
  }

  const keys = [site.user, site.pass, ...(site.company ? [site.company] : [])]
  chrome.storage.local.get(keys, (creds) => {
    const u = creds[site.user] || ''
    const p = creds[site.pass] || ''
    const comp = site.company ? (creds[site.company] || '') : ''
    let tries = 0
    const timer = setInterval(() => {
      tries++
      const pw = document.querySelector('input[type="password"]')
      // No password field ⇒ this isn't a login page (normal app page). Give it a
      // few ticks in case the form renders late, then stop quietly — never badge.
      // On a clopay host, first nudge the OIDC handoff along (stalled form / blank
      // callback) so unattended re-login can complete.
      if (!pw) {
        if (isClopayAuthHost) { try { oidcContinue(); if (tries === 6) recoverBlankOidc() } catch { /* ignore */ } }
        if (tries > 8) clearInterval(timer)
        return
      }
      clearInterval(timer)
      if (sessionStorage.getItem(triedKey)) { LOG(site.label, '— already tried this tab; flagging for manual login'); flag(); return }
      if (u && p) loginWithCreds(pw, u, p, comp)
      else loginWithAutofill(pw)
    }, 500)
  })
})()
