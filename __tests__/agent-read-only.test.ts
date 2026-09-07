import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// Hard constraint for every agent channel (Cassie email, future phone agent):
// read-only against Service Fusion. The general SF client (lib/crm/service-fusion)
// exposes POST/PUT and is used elsewhere in Castle Admin to create jobs; nothing
// under lib/agent may import it. Live reads go through the GET-only mirror client
// (lib/sf-mirror/client), whose own test proves it cannot write.

const ROOT = join(__dirname, '..')
const FORBIDDEN = [
  /['"]@\/lib\/crm\/service-fusion['"]/,
  /['"]@\/lib\/crm['"]/,
  /['"]\.\.?\/.*crm\/service-fusion['"]/,
  /\bsfPost\b|\bsfPut\b/,
  /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(name) ? [p] : [])
  })
}

describe('lib/agent is read-only against Service Fusion', () => {
  const files = walk(join(ROOT, 'lib/agent'))
  it('has files to check', () => expect(files.length).toBeGreaterThan(0))
  // Files that legitimately POST to OTHER services (Gmail, Anthropic). They must not so
  // much as mention Service Fusion, so a write verb there cannot be aimed at it.
  const NON_SF_WRITERS = new Set(['lib/agent/email/gmail.ts'])
  for (const f of files) {
    const rel = f.replace(ROOT + '/', '')
    it(`${rel} imports no write-capable SF client and issues no write verbs`, () => {
      const src = readFileSync(f, 'utf8')
      if (NON_SF_WRITERS.has(rel)) {
        expect(src, 'a non-SF writer must not reference Service Fusion at all').not.toMatch(/servicefusion|sf-mirror|sfGet|\/jobs\//i)
        for (const re of FORBIDDEN.slice(0, 4)) expect(src, `matched ${re}`).not.toMatch(re)
        return
      }
      for (const re of FORBIDDEN) expect(src, `matched ${re}`).not.toMatch(re)
    })
  }
})
