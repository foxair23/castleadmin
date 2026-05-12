#!/usr/bin/env node
// Fetches a single SF job by its internal numeric ID and prints all fields.
// Run via GitHub Actions or locally with env vars set.
//
// Usage: node scripts/check-sf-job.mjs [internalId]
// If no ID provided, fetches the first job from the list.

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL = 'https://api.servicefusion.com/v1'

const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET']
for (const k of required) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1) }
}

async function getToken() {
  const resp = await fetch(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
  })
  if (!resp.ok) throw new Error(`SF auth failed (${resp.status}): ${await resp.text()}`)
  return (await resp.json()).access_token
}

async function sfGet(path) {
  const token = await getToken()
  const resp = await fetch(`${SF_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) throw new Error(`SF API error (${resp.status}): ${await resp.text()}`)
  return resp.json()
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
