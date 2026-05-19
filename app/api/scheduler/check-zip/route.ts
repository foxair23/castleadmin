import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  const zip = req.nextUrl.searchParams.get('zip')?.trim()

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'Invalid ZIP code' }, { status: 400 })
  }

  const db = serviceClient()

  // Look up which cities this ZIP maps to
  const { data: zipRows, error: zipErr } = await db
    .from('scheduler_city_zip_map')
    .select('city')
    .eq('zip', zip)
    .limit(50)

  if (zipErr) {
    console.error('[check-zip] zip map error:', zipErr)
    return NextResponse.json({ in_service_area: true }) // fail open
  }

  if (!zipRows || zipRows.length === 0) {
    return NextResponse.json({ in_service_area: false })
  }

  const cities = zipRows.map((r) => r.city)

  // Check whether any of those cities are in the active service area
  const { data: areaRows, error: areaErr } = await db
    .from('scheduler_service_area_cities')
    .select('id')
    .eq('is_active', true)
    .in('city', cities)
    .limit(1)

  if (areaErr) {
    console.error('[check-zip] area cities error:', areaErr)
    return NextResponse.json({ in_service_area: true }) // fail open
  }

  return NextResponse.json({ in_service_area: (areaRows?.length ?? 0) > 0 })
}
