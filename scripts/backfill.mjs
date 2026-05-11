#!/usr/bin/env node
// Full historical backfill — runs in Node.js, no browser required.
// Usage: node scripts/backfill.mjs [jobs] [invoices] [estimates] [customers]
// Default: runs all four entities in order.
//
// Required env vars:
//   SF_CLIENT_ID, SF_CLIENT_SECRET
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL  = 'https://api.servicefusion.com/v1'
const TIMEOUT_MS   = 20_000   // 20 s per SF request — generous for slow API moments
const PER_PAGE     = 50       // jobs; invoices/estimates/customers use 100

// ── Env validation ────────────────────────────────────────────────────────
const required = ['SF_CLIENT_ID','SF_CLIENT_SECRET','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1) }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
const parsedUrl = new URL(supabaseUrl)
console.log(`Supabase host: ${parsedUrl.host}`)
console.log(`Supabase pathname: "${parsedUrl.pathname}"`)
console.log(`Service key length: ${supabaseKey.length}, starts with eyJ: ${supabaseKey.startsWith('eyJ')}`)
const db = createClient(supabaseUrl, supabaseKey)

async function testDb() {
  // Test 1: profiles table (always exists)
  const profilesUrl = `${supabaseUrl}/rest/v1/profiles?select=id&limit=1`
  const r1 = await fetch(profilesUrl, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Accept': 'application/json' }
  })
  console.log(`  profiles table: HTTP ${r1.status}`)
  if (!r1.ok) console.log(`  profiles body: ${(await r1.text()).slice(0, 200)}`)

  // Test 2: sf_jobs_cache table
  const jobsUrl = `${supabaseUrl}/rest/v1/sf_jobs_cache?select=id&limit=1`
  const r2 = await fetch(jobsUrl, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Accept': 'application/json' }
  })
  console.log(`  sf_jobs_cache table: HTTP ${r2.status}`)
  if (!r2.ok) console.log(`  sf_jobs_cache body: ${(await r2.text()).slice(0, 200)}`)

  if (!r2.ok) throw new Error(`sf_jobs_cache not accessible (HTTP ${r2.status})`)
  console.log('  Supabase connection OK.')
}

// ── SF auth ───────────────────────────────────────────────────────────────
let sfToken = null

async function getToken() {
  if (sfToken) return sfToken
  const resp = await fetchWithTimeout(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
  })
  if (!resp.ok) throw new Error(`SF auth failed (${resp.status}): ${await resp.text()}`)
  const json = await resp.json()
  sfToken = json.access_token
  console.log('  SF token obtained.')
  return sfToken
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function sfGet(path, params = {}) {
  const token = await getToken()
  const url = new URL(`${SF_BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let attempt = 0
  while (true) {
    attempt++
    try {
      const resp = await fetchWithTimeout(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      if (resp.status === 429) {
        console.log('  Rate limited — waiting 10 s...')
        await sleep(10_000)
        continue
      }
      if (!resp.ok) throw new Error(`SF API error (${resp.status}): ${await resp.text()}`)
      return resp.json()
    } catch (err) {
      if (attempt >= 3) throw err
      const wait = attempt * 3_000
      console.log(`  SF request failed (${err.message}), retry in ${wait/1000}s...`)
      await sleep(wait)
      sfToken = null // force token refresh on next attempt
    }
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────
function isClosed(statusName) {
  const s = (statusName ?? '').toLowerCase()
  return s.includes('closed') || s.includes('completed') || s.includes('invoiced') || s.includes('paid')
}

async function writeJobs(raws) {
  if (!raws.length) return 0
  const now = new Date().toISOString()
  const ids = raws.map(r => String(r.id))

  const { data: existing } = await db.from('sf_jobs_cache')
    .select('id, status_name, scheduled_at, original_scheduled_at, reschedule_count, parts_reschedule_count, schedule_history_truncated')
    .in('id', ids)

  const existingMap = new Map((existing ?? []).map(r => [r.id, r]))

  const jobRows = [], statusRows = [], schedRows = [], techRows = []

  for (const raw of raws) {
    const jobId      = String(raw.id)
    const statusName = raw.status ?? ''
    const closed     = isClosed(statusName)
    const scheduledAt   = raw.start_date  ? new Date(raw.start_date).toISOString()  : null
    const completedAt   = raw.closed_at   ? new Date(raw.closed_at).toISOString()   : null
    const createdAtSf   = raw.created_at  ? new Date(raw.created_at).toISOString()  : null

    const ex = existingMap.get(jobId) ?? null
    const prevStatus = ex?.status_name ?? null

    if (prevStatus !== statusName && statusName) {
      statusRows.push({ sf_job_id: jobId, status: statusName,
        status_category: closed ? 'Closed Jobs' : 'Open Jobs',
        previous_status: prevStatus, observed_at: now })
    }

    let originalScheduledAt = ex?.original_scheduled_at ?? null
    const rescheduleCount      = ex?.reschedule_count ?? 0
    const partsRescheduleCount = ex?.parts_reschedule_count ?? 0
    const schedTruncated       = ex ? (ex.schedule_history_truncated ?? false) : true // backfill

    if (!ex) {
      originalScheduledAt = scheduledAt
      if (scheduledAt) {
        schedRows.push({ sf_job_id: jobId, scheduled_at: scheduledAt,
          previous_scheduled_at: null, observed_at: now,
          change_type: 'initial', reschedule_reason: null,
          reschedule_reason_source: null, job_status_at_change: statusName })
      }
    }

    jobRows.push({
      id: jobId,
      customer_id:    raw.customer_id ? String(raw.customer_id) : null,
      category_name:  raw.category ?? null,
      status_name:    statusName,
      status_category: closed ? 'Closed Jobs' : 'Open Jobs',
      is_closed:      closed,
      created_at_sf:  createdAtSf,
      scheduled_at:   scheduledAt,
      original_scheduled_at: originalScheduledAt,
      completed_at:   completedAt,
      total_amount:   raw.total != null ? parseFloat(String(raw.total)) : null,
      lead_source:    raw.source ?? null,
      zip:            raw.postal_code ?? null,
      reschedule_count:       rescheduleCount,
      parts_reschedule_count: partsRescheduleCount,
      schedule_history_truncated: schedTruncated,
      synced_at: now,
    })

    for (const t of raw.techs_assigned ?? []) {
      techRows.push({ sf_job_id: jobId, sf_tech_id: String(t.id), synced_at: now })
    }
  }

  const { error: jobErr } = await db.from('sf_jobs_cache').upsert(jobRows, { onConflict: 'id' })
  if (jobErr) throw new Error(`jobs upsert: ${jobErr.message}`)
  if (statusRows.length) await db.from('sf_job_status_history').insert(statusRows)
  if (schedRows.length)  await db.from('sf_job_schedule_history').insert(schedRows)
  if (techRows.length)   await db.from('sf_job_techs_cache').upsert(techRows, { onConflict: 'sf_job_id,sf_tech_id' })

  return raws.length
}

async function writeInvoices(raws) {
  if (!raws.length) return 0
  const now = new Date().toISOString()
  const rows = raws.map(inv => ({
    id:          String(inv.id),
    job_id:      inv.job_id               ? String(inv.job_id)                          : null,
    customer_id: inv.bill_to_customer_id  ? String(inv.bill_to_customer_id)             : null,
    issued_at:   inv.date                 ? new Date(inv.date).toISOString()            : null,
    due_at:      inv.due_date             ? new Date(inv.due_date).toISOString()        : null,
    total:       inv.total    != null     ? parseFloat(String(inv.total))               : null,
    balance_due: null,
    paid_at:     null,
    synced_at: now,
  }))
  const { error } = await db.from('sf_invoices_cache').upsert(rows, { onConflict: 'id' })
  if (error) throw new Error(`invoices upsert: ${error.message}`)
  return rows.length
}

async function writeEstimates(raws) {
  if (!raws.length) return 0
  const now = new Date().toISOString()
  const rows = raws.map(est => ({
    id:               String(est.id),
    customer_id:      est.customer_id ? String(est.customer_id) : null,
    assigned_tech_id: est.tech_id     ? String(est.tech_id)     : null,
    status:           est.status ?? null,
    created_at_sf:    est.created_at  ? new Date(est.created_at).toISOString() :
                      est.created     ? new Date(est.created).toISOString()    : null,
    accepted_at:      est.accepted_date ? new Date(est.accepted_date).toISOString() : null,
    declined_at:      est.declined_date ? new Date(est.declined_date).toISOString() : null,
    total:            est.total != null ? parseFloat(String(est.total)) : null,
    synced_at: now,
  }))
  const { error } = await db.from('sf_estimates_cache').upsert(rows, { onConflict: 'id' })
  if (error) throw new Error(`estimates upsert: ${error.message}`)
  return rows.length
}

async function writeCustomers(raws) {
  if (!raws.length) return 0
  const now = new Date().toISOString()
  const rows = raws.map(c => ({
    id:           String(c.id),
    created_at_sf: c.created_at ? new Date(c.created_at).toISOString() :
                   c.created    ? new Date(c.created).toISOString()    : null,
    lead_source:  c.source ?? c.lead_source ?? null,
    zip:          c.postal_code ?? c.zip ?? null,
    synced_at: now,
  }))
  const { error } = await db.from('sf_customers_cache').upsert(rows, { onConflict: 'id' })
  if (error) throw new Error(`customers upsert: ${error.message}`)
  return rows.length
}

// ── Generic paged fetch+write ─────────────────────────────────────────────
async function runEntity(name, sfPath, perPage, writeFn, extraParams = {}) {
  console.log(`\n── ${name} ──────────────────────────────`)
  let page = 1, total = 0, pagesTotal = null

  while (true) {
    process.stdout.write(`  Page ${page}${pagesTotal ? `/${pagesTotal}` : ''} fetching...`)
    const params = { 'per-page': String(perPage), page: String(page), ...extraParams }
    if (name === 'Jobs') params.expand = 'techs_assigned'
    const json = await sfGet(sfPath, params)
    const items = json?.items ?? []
    const meta  = json?._meta ?? {}
    pagesTotal  = meta.pageCount ?? 1

    if (page === 1 && items.length > 0) {
      console.log(`\n  Fields: ${Object.keys(items[0]).join(', ')}`)
    }

    process.stdout.write(` writing ${items.length} records...`)
    const written = await writeFn(items)
    total += written
    console.log(` done. (total so far: ${total})`)

    if (page >= pagesTotal) break
    page++
    await sleep(200) // small pause to be polite to SF API
  }

  console.log(`  ✓ ${name} complete — ${total} records.`)
  return total
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Main ──────────────────────────────────────────────────────────────────
const ENTITIES = ['jobs', 'invoices', 'estimates', 'customers']
const toRun = process.argv.slice(2).filter(a => ENTITIES.includes(a))
const entities = toRun.length ? toRun : ENTITIES

console.log(`Castle Admin — Historical Backfill`)
console.log(`Entities: ${entities.join(', ')}`)
console.log(`Started: ${new Date().toISOString()}`)

try {
  await testDb()
  if (entities.includes('jobs')) {
    await runEntity('Jobs', '/jobs', PER_PAGE, writeJobs)
  }
  if (entities.includes('invoices')) {
    await runEntity('Invoices', '/invoices', 100, writeInvoices)
  }
  if (entities.includes('estimates')) {
    await runEntity('Estimates', '/estimates', 100, writeEstimates)
  }
  if (entities.includes('customers')) {
    await runEntity('Customers', '/customers', 25, writeCustomers)
  }

  console.log(`\nBackfill complete! ${new Date().toISOString()}`)
  process.exit(0)
} catch (err) {
  console.error(`\nBackfill failed: ${err.message}`)
  process.exit(1)
}
