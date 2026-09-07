// Config + last-run status, persisted in chrome.storage.local.

export const DEFAULTS = {
  enabled: false,          // master switch for the background poll
  dryRun: true,            // do everything EXCEPT the final SF submit
  baseUrl: '',             // Castle Admin origin, e.g. https://hq.castlegarage.com (set in Options on the office PC)
  token: '',               // matches REMITTANCE_APPLY_TOKEN on the server
  pollMinutes: 10,
  receivedBy: 'RA',        // Payment[received_by] value in SF
  genieEnabled: true,      // scrape + log Genie/Home Depot portal orders (content script)
  genieAutoDetail: false,  // after a list scrape, auto-open orders to scrape their detail (backfills address/phone/store#)
  maxDetailPerRun: 12,     // cap orders auto-detailed per list visit (keeps the sweep bounded/reliable)
  genieScheduleEnabled: false, // auto-crawl on a schedule (hourly 7a–6p Mon–Sat + nightly full) — office PC only
  // Clopay HD Program portal (hdprogram.clopay.com) — mirrors the Genie options.
  clopayEnabled: true,           // scrape + log Clopay portal orders (content script)
  clopayAutoDetail: false,       // (legacy; API crawler always fetches detail) kept for options compatibility
  clopayInstallerNum: '56505',   // Castle's Clopay dealer/installer number — used for the API list/detail calls
  clopayMaxDetailPerRun: 12,     // cap orders detailed per manual run (full/scheduled crawls use a larger cap)
  clopayScheduleEnabled: false,  // auto-crawl on a schedule (hourly 7a–6p Mon–Sat + nightly full) — office PC only
  clopayStoreDocs: true,         // download + store Clopay document FILES on our server (via the doc-sync job)
  clopayDocSyncEnabled: true,    // run the nightly Clopay document-sync job (~2am PT) — office PC only
  clopayMaxDocsPerRun: 300,      // cap documents captured per doc-sync run (resumable across runs via dedup)
  // Saved logins for unattended re-login (this machine's local storage only).
  // Chrome won't let a script submit ITS autofilled password (anti-phishing), so
  // the login content script types these in itself. Leave blank to skip.
  genieUser: '', geniePass: '',   // Genie / Home Depot portal
  clopayUser: '', clopayPass: '', // Clopay HD Program portal
  sfCompany: 'castlegaragedoors', // Service Fusion login also needs a Company ID
  sfUser: '', sfPass: '',         // Service Fusion (note/payment posting needs a live session)
  castleUser: '', castlePass: '', // Castle Admin (optional — the extension normally uses the token)
}

export async function getConfig() {
  const c = await chrome.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...c }
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch)
}

export async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: { ...status, at: Date.now() } })
}

export async function getStatus() {
  const { lastStatus } = await chrome.storage.local.get('lastStatus')
  return lastStatus || null
}
