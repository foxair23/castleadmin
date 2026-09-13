import type { SupabaseClient } from '@supabase/supabase-js'

// Every person's name the reply agent must never write: app users of any role
// (techs, admins, sales) plus every technician name Service Fusion has ever put
// on a job. Loaded once per drafting pass.
export async function loadTechRoster(db: SupabaseClient): Promise<string[]> {
  const [{ data: profiles }, { data: techs }] = await Promise.all([
    db.from('profiles').select('full_name').limit(1000),
    db.from('sf_job_techs').select('tech_first_name, tech_last_name').limit(5000),
  ])
  const names = new Set<string>()
  for (const p of (profiles ?? []) as Array<{ full_name: string | null }>) if (p.full_name?.trim()) names.add(p.full_name.trim())
  for (const t of (techs ?? []) as Array<{ tech_first_name: string | null; tech_last_name: string | null }>) {
    const n = [t.tech_first_name, t.tech_last_name].filter(Boolean).join(' ').trim()
    if (n) names.add(n)
  }
  return [...names]
}
