// Content script — Genie / Home Depot portal LOGIN page (Oracle OAM), e.g.
// install.openings.net/CustomLogin/InsLogin. A scheduled crawl (or an expired
// session) lands here. We don't store credentials — we rely on Chrome's saved
// password autofill, then submit for you so the crawl keeps going unattended:
//   1. wait for Chrome to autofill username + password,
//   2. submit — try the button, then Enter on the password field, then the form,
//   3. if it still doesn't take (autofill off / MFA / changed form), flag the
//      background so it badges the toolbar + emails whoever you chose.
// A per-tab guard prevents a submit loop if the credentials don't take.

(() => {
  const LOG = (...a) => console.log('[genie-login]', ...a)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const flag = () => { try { chrome.runtime.sendMessage({ type: 'genie-login-detected', url: location.href }) } catch { /* ignore */ } }

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
  const findSubmit = () =>
    [...document.querySelectorAll('input[type="submit"], button[type="submit"], button, input[type="button"], a.btn, .btn')]
      .find(el => visible(el) && /log ?in|sign ?in|submit|continue|next/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''} ${el.name || ''}`))
    || [...document.querySelectorAll('input[type="submit"], button[type="submit"], button')].find(visible)

  async function trySubmit() {
    const pw = document.querySelector('input[type="password"]')
    if (!pw) return
    sessionStorage.setItem('genieLoginTried', '1')
    LOG('credentials present — submitting')
    // 1) the button
    const btn = findSubmit()
    if (btn) realClick(btn)
    await sleep(1600)
    // 2) Enter on the password field (still here ⇒ button didn't navigate)
    pressEnter(pw)
    await sleep(1600)
    // 3) submit the form directly
    const form = pw.form
    if (form) { try { form.requestSubmit ? form.requestSubmit() : form.submit() } catch { /* ignore */ } }
    await sleep(1600)
    // Still on the login page after all that → hand off to manual.
    LOG('submit did not navigate — flagging for manual login')
    flag()
  }

  // Chrome sometimes won't autofill saved credentials until the page gets some
  // interaction — which never happens when nobody's at the machine. Nudge it:
  // focus the fields (and a body click) to coax the fill.
  function nudge(user, pw) {
    LOG('nudging autofill')
    try {
      document.body && document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      if (user) { user.focus(); user.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); user.click && user.click() }
      if (pw) { pw.focus() }
      if (user) user.focus() // end on username so Chrome fills the pair
    } catch { /* ignore */ }
  }

  if (sessionStorage.getItem('genieLoginTried')) { LOG('already tried this tab session — flagging for manual login'); flag(); return }

  LOG('on login page', location.href)
  let tries = 0
  const timer = setInterval(() => {
    tries++
    const pw = document.querySelector('input[type="password"]')
    const user = document.querySelector('input[type="text"], input[type="email"], input[name*="user" i], input[id*="user" i]')
    // Submit once both fields are populated (Chrome autofill can lag a second or two).
    if (pw && pw.value && user && user.value) { clearInterval(timer); trySubmit() }
    else {
      // Nudge autofill at ~2s and ~5s if the fields are still empty.
      if ((tries === 4 || tries === 10) && (pw || user)) nudge(user, pw)
      if (tries > 30) { clearInterval(timer); LOG('no autofilled credentials after ~15s — flagging for manual login'); flag() }
    }
  }, 500)
})()
