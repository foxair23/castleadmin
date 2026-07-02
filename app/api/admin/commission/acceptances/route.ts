import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { fmtCurrency, fmtPercent, fmtPeriodLabel } from '@/lib/commission/acceptance'

export const maxDuration = 60

interface Snapshot {
  sales_target?: number
  rate_below?: number
  rate_above?: number
  period_label?: string
  legal_version?: string
}

// GET — the acceptance log (who accepted what, when). ?format=csv for export.
export async function GET(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = await createServiceClient()
  const { data: rows } = await db
    .from('commission_plan_acceptances')
    .select('id, tech_user_id, period_start, period_end, accepted_name, accepted_at, ip, legal_version, terms_snapshot')
    .order('accepted_at', { ascending: false })
    .limit(2000)

  const techIds = [...new Set((rows ?? []).map(r => r.tech_user_id))]
  const nameMap = new Map<string, string>()
  if (techIds.length > 0) {
    const { data: profs } = await db.from('profiles').select('id, full_name').in('id', techIds)
    for (const p of (profs ?? []) as { id: string; full_name: string | null }[]) nameMap.set(p.id, p.full_name ?? '')
  }

  const items = (rows ?? []).map(r => {
    const snap = (r.terms_snapshot ?? {}) as Snapshot
    return {
      id: r.id,
      tech_user_id: r.tech_user_id,
      tech_name: nameMap.get(r.tech_user_id) ?? '—',
      period_label: snap.period_label ?? fmtPeriodLabel(r.period_start),
      period_start: r.period_start,
      period_end: r.period_end,
      accepted_name: r.accepted_name,
      accepted_at: r.accepted_at,
      ip: r.ip,
      legal_version: r.legal_version,
      sales_target: snap.sales_target ?? null,
      rate_below: snap.rate_below ?? null,
      rate_above: snap.rate_above ?? null,
    }
  })

  if (req.nextUrl.searchParams.get('format') === 'csv') {
    const header = ['Technician', 'Period', 'Sales Target', 'Rate Below', 'Rate Above', 'Signed Name', 'Accepted At (PT)', 'IP', 'Legal Version']
    const csvRows = items.map(i => [
      i.tech_name,
      i.period_label,
      i.sales_target != null ? fmtCurrency(i.sales_target) : '',
      i.rate_below != null ? fmtPercent(i.rate_below) : '',
      i.rate_above != null ? fmtPercent(i.rate_above) : '',
      i.accepted_name,
      new Date(i.accepted_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
      i.ip ?? '',
      i.legal_version,
    ])
    const csv = [header, ...csvRows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="commission-acceptances.csv"',
      },
    })
  }

  return NextResponse.json({ items })
}
