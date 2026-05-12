#!/usr/bin/env node
// Fetches a single SF job by its internal numeric ID and prints all fields.
// Run via GitHub Actions or locally with env vars set.
//
// Usage: node scripts/check-sf-job.mjs [internalId]
// If no ID provided, fetches the first job from the list.

import { setGlobalDispatcher, Agent } from 'node:undici'

// Override undici's default headers timeout (too short for SF API)
setGlobalDispatcher(new Agent({ headersTimeout: 60_000, bodyTimeout: 60_000 }))

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL = 'https://api.servicefusion.com/v1'
const TIMEOUT_MS = 45_000

const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET']
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1) }
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try { return await fetch(url, { ...opts, signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

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
  sfToken = (await resp.json()).access_token
  return sfToken
}

async function sfGet(path) {
  let attempt = 0
  while (true) {
    attempt++
    try {
      const token = await getToken()
      const resp = await fetchWithTimeout(`${SF_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      if (!resp.ok) throw new Error(`SF API error (${resp.status}): ${await resp.text()}`)
      return resp.json()
    } catch (err) {
      if (attempt >= 3) throw err
      console.log(`  Attempt ${attempt} failed (${err.message}), retrying...`)
      sfToken = null
      await new Promise(r => setTimeout(r, attempt * 3000))
    }
  }
}

const argId = process.argv[2]
let internalId = argId

if (!internalId) {
  console.log('No ID provided — fetching first job from list to get an ID...')
  const list = await sfGet('/jobs?per-page=1')
  internalId = list?.items?.[0]?.id
  console.log(`Using internal ID: ${internalId}`)
}

console.log(`\nFetching /jobs/${internalId}...`)
const job = await sfGet(`/jobs/${internalId}`)

console.log('\n=== FIELDS ===')
console.log(Object.keys(job).join(', '))

console.log('\n=== FULL JOB ===')
console.log(JSON.stringify(job, null, 2))
