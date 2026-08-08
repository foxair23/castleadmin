// Content script — Genie / Home Depot portal LOGIN page (Oracle OAM), e.g.
// install.openings.net/CustomLogin/InsLogin. A scheduled crawl lands here when
// the session has expired. We don't store credentials; we rely on Chrome's saved
// password autofill:
//   1. wait briefly for Chrome to autofill username + password,
//   2. if both are filled, submit once (re-login is automatic),
//   3. if not (autofill off, MFA, changed form), tell the background so it can
//      badge the toolbar and surface this tab for a one-click manual login.
// A per-tab guard prevents a submit loop if the credentials don't take.

(() => {
  const LOG = (...a) => console.log('[genie-login]', ...a)
  const flag = () => { try { chrome.runtime.sendMessage({ type: 'genie-login-detected', url: location.href }) } catch { /* ignore */ } }

  LOG('on login page', location.href)

  if (sessionStorage.getItem('genieLoginTried')) { LOG('already tried this session — flagging for manual login'); flag(); return }

  let tries = 0
  const timer = setInterval(() => {
    tries++
    const pw = document.querySelector('input[type="password"]')
    const user = document.querySelector('input[type="text"], input[type="email"], input[name*="user" i], input[id*="user" i]')
    if (pw && pw.value && user && user.value) {
      clearInterval(timer)
      sessionStorage.setItem('genieLoginTried', '1')
      const btn = document.querySelector('button[type="submit"], input[type="submit"], button, .btn')
      LOG('credentials autofilled — submitting')
      if (btn) btn.click()
      else if (pw.form) pw.form.submit()
      return
    }
    if (tries > 12) { // ~6s with no autofill → hand off to manual
      clearInterval(timer)
      LOG('no autofilled credentials — flagging for manual login')
      flag()
    }
  }, 500)
})()
