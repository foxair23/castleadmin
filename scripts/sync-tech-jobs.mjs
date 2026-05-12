#!/usr/bin/env node
// Syncs SF jobs into the piecework jobs table for all active mapped technicians.
// Uses the same listJobsForTech logic as the individual tech sync button —
// queries SF by date range + techs_assigned, which is reliable.
//
// Usage:
//   node scripts/sync-tech-jobs.mjs                  # last 52 weeks
//   node scripts/sync-tech-jobs.mjs --weeks=12        # last 12 weeks
//   node scripts/sync-tech-jobs.mjs --from=2025-01-01 # from a specific date
//
// Required env vars:
//   SF_CLIENT_ID, SF_CLIENT_SECRET
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL = 'https://api.servicefusion.com/v1'
const TIMEOUT_MS = 30_000

// ── Env validation ────────────────────────────────────────────────────────
const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1) }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
const db = createClient(supabaseUrl, supabaseKey)

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const weeksArg = args.find(a => a.startsWith('--weeks='))
const fromArg = args.find(a => a.startsWith('--from='))

let fromDate
if (fromArg) {
  fromDate = new Date(fromArg.replace('--from=', '') + 'T00:00:00')
  if (isNaN(fromDate)) { console.error('Invalid --from date'); process.exit(1) }
} else {
  const weeks = parseInt(weeksArg?.replace('--weeks=', '') ?? '52')
  fromDate = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
}

console.log(`Castle Admin — Tech Jobs Sync`)
console.log(`From: ${fromDate.toISOString().slice(0, 10)}`)
console.log(`Started: ${new Date().toISOString()}`)

// ── SF auth ───────────────────────────────────────────────────────────────
let sfToken = null

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try { return await fetch(url, { ...opts, signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

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
  return sfToken
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
        console.log('  Rate limited — waiting 10s...')
        await sleep(10_000)
        continue
      }
      if (!resp.ok) throw new Error(`SF API error (${resp.status}): ${await resp.text()}`)
      return resp.json()
    } catch (err) {
      if (attempt >= 3) throw err
      const wait = attempt * 3_000
      console.log(`  SF request failed (${err.message}), retry in ${wait / 1000}s...`)
      await sleep(wait)
      sfToken = null
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function fmt(d) { return d.toISOString().slice(0, 10) }

function getWeekStart(d) {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const result = new Date(d)
  result.setDate(d.getDate() + diff)
  result.setHours(0, 0, 0, 0)
  return result
}

// ── Build list of weeks to sync ───────────────────────────────────────────
function buildWeeks(from) {
  const weeks = []
  const today = new Date()
  let weekStart = getWeekStart(today)

  while (weekStart >= getWeekStart(from)) {
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    weeks.push({ start: fmt(weekStart), end: fmt(weekEnd) })
    weekStart.setDate(weekStart.getDate() - 7)
  }
  return weeks
}

// ── Fetch jobs for a tech+week from SF ───────────────────────────────────
async function fetchJobsForTech(sfTechId, weekStart, weekEnd) {
  const results = []
  let page = 1

  while (true) {
    const json = await sfGet('/jobs', {
      'filters[start_date][gte]': weekStart,
      'filters[start_date][lte]': weekEnd,
      expand: 'techs_assigned',
      'per-page': '50',
      page: String(page),
    })

    const items = json?.items ?? []
    for (const job of items) {
      const techs = job.techs_assigned ?? []
      if (!techs.some(t => String(t.id) === sfTechId)) continue

      const statusStr = job.status ?? ''
      const lower = statusStr.toLowerCase()
      let status = null
      if (lower.includes('closed')) status = 'completed'
      else if (!lower.includes('cancel') && !lower.includes('estimate')) status = 'assigned'
      if (!status) continue

      results.push({
        id: String(job.id),
        jobNumber: job.number ?? String(job.id),
        customerName: job.customer_name ?? `SF Job #${job.id}`,
        scheduledDate: (job.start_date ?? weekStart).slice(0, 10),
        status,
      })
    }

    const meta = json?._meta ?? {}
    if (page >= (meta.pageCount ?? 1)) break
    page++
    await sleep(100)
  }

  return results
}

// ── Main ──────────────────────────────────────────────────────────────────
const { data: profiles, error: profilesErr } = await db
  .from('profiles')
  .select('id, full_name, sf_technician_id')
  .eq('role', 'technician')
  .eq('is_active', true)
  .not('sf_technician_id', 'is', null)

if (profilesErr) { console.error('Failed to load profiles:', profilesErr.message); process.exit(1) }
console.log(`\nTechnicians to sync: ${profiles.length}`)
for (const p of profiles) console.log(`  - ${p.full_name} (SF ID: ${p.sf_technician_id})`)

const weeks = buildWeeks(fromDate)
console.log(`\nWeeks to sync: ${weeks.length} (${weeks[weeks.length - 1].start} → ${weeks[0].start})`)

let grandAdded = 0
let grandUpdated = 0
const now = new Date().toISOString()

for (const { start: weekStart, end: weekEnd } of weeks) {
  process.stdout.write(`\nWeek ${weekStart}:`)

  // Fetch all techs' jobs for this week
  const techJobMap = new Map()
  for (const profile of profiles) {
    try {
      const sfJobs = await fetchJobsForTech(String(profile.sf_technician_id), weekStart, weekEnd)
      if (sfJobs.length > 0) techJobMap.set(profile, sfJobs)
      process.stdout.write(` ${profile.full_name.split(' ')[0]}(${sfJobs.length})`)
    } catch (err) {
      process.stdout.write(` ${profile.full_name.split(' ')[0]}(err)`)
    }
  }

  // Bulk-check existing jobs
  const allSfJobIds = [...new Set([...techJobMap.values()].flat().map(j => j.id))]
  const existingSet = new Set()
  if (allSfJobIds.length > 0) {
    const { data: existing } = await db
      .from('jobs')
      .select('tech_id, sf_job_id')
      .in('sf_job_id', allSfJobIds)
      .not('sf_job_id', 'is', null)
    for (const row of existing ?? []) {
      existingSet.add(`${row.tech_id}::${row.sf_job_id}`)
    }
  }

  // Insert or update
  let weekAdded = 0, weekUpdated = 0
  for (const [profile, sfJobs] of techJobMap) {
    for (const sfJob of sfJobs) {
      const key = `${profile.id}::${sfJob.id}`
      if (existingSet.has(key)) {
        await db.from('jobs')
          .update({ sf_status: sfJob.status, sf_job_number: sfJob.jobNumber, sf_last_synced_at: now })
          .eq('tech_id', profile.id)
          .eq('sf_job_id', sfJob.id)
        weekUpdated++
      } else {
        await db.from('jobs').insert({
          tech_id: profile.id,
          work_date: sfJob.scheduledDate,
          job_name: sfJob.customerName,
          notes: null,
          total_pay: 0,
          week_start_date: weekStart,
          source: 'service_fusion',
          sf_job_id: sfJob.id,
          sf_job_number: sfJob.jobNumber,
          sf_status: sfJob.status,
          sf_last_synced_at: now,
        })
        weekAdded++
      }
    }
  }

  process.stdout.write(` → +${weekAdded} added, ~${weekUpdated} updated`)
  grandAdded += weekAdded
  grandUpdated += weekUpdated
}

console.log(`\n\nSync complete!`)
console.log(`Total added: ${grandAdded}`)
console.log(`Total updated: ${grandUpdated}`)
console.log(`Finished: ${new Date().toISOString()}`)
