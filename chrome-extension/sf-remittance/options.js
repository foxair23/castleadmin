import { getConfig, setConfig } from './store.js'

const fields = ['baseUrl', 'token', 'receivedBy', 'pollMinutes', 'maxDetailPerRun', 'genieUser', 'sfUser', 'castleUser']
const passwords = ['geniePass', 'sfPass', 'castlePass']
const checks = ['enabled', 'dryRun', 'genieEnabled', 'genieAutoDetail', 'genieScheduleEnabled']

async function load() {
  const c = await getConfig()
  for (const f of fields) document.getElementById(f).value = c[f] ?? ''
  for (const f of passwords) document.getElementById(f).value = c[f] ?? ''
  for (const f of checks) document.getElementById(f).checked = !!c[f]
}

document.getElementById('save').addEventListener('click', async () => {
  const patch = {}
  for (const f of fields) patch[f] = document.getElementById(f).value.trim()
  // Passwords kept verbatim — never trimmed (leading/trailing chars can be real).
  for (const f of passwords) patch[f] = document.getElementById(f).value
  patch.pollMinutes = Math.max(1, Number(patch.pollMinutes) || 10)
  patch.maxDetailPerRun = Math.min(220, Math.max(1, Number(patch.maxDetailPerRun) || 12))
  for (const f of checks) patch[f] = document.getElementById(f).checked
  await setConfig(patch)
  // Re-arm the alarm with the new interval.
  chrome.alarms.create('sf-remittance-poll', { periodInMinutes: patch.pollMinutes })
  const s = document.getElementById('saved'); s.style.display = 'inline'; setTimeout(() => s.style.display = 'none', 1500)
})

load()
