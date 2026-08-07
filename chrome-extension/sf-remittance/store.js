// Config + last-run status, persisted in chrome.storage.local.

export const DEFAULTS = {
  enabled: false,          // master switch for the background poll
  dryRun: true,            // do everything EXCEPT the final SF submit
  baseUrl: '',             // Castle Admin origin, e.g. https://castleadmin.vercel.app
  token: '',               // matches REMITTANCE_APPLY_TOKEN on the server
  pollMinutes: 10,
  receivedBy: 'RA',        // Payment[received_by] value in SF
  genieEnabled: true,      // scrape + log Genie/Home Depot portal orders (content script)
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
