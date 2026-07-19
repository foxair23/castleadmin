import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Step 1 of the direct-to-storage upload flow. Vercel caps request bodies at
// ~4.5 MB, so full-size phone photos can never travel THROUGH our API — the
// old multipart route failed platform-side before our code ran. Instead the
// widget asks here for signed upload URLs (after validation), PUTs each file
// straight to Supabase Storage (25 MB bucket limit applies there), then calls
// /api/scheduler/uploads/complete to record the attachment.

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  /^http:\/\/localhost:\d+$/,
]

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
]

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
}

const STORAGE_BUCKET = 'scheduler-uploads'

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin &&
    ALLOWED_ORIGINS.some((o) =>
      typeof o === 'string' ? o === origin : o.test(origin)
    )
  return {
    'Access-Control-Allow-Origin': allowed ? origin! : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Castle-Widget-Key',
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

interface SignRequest {
  lead_id: string
  files: { name: string; type: string; size: number }[]
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))

  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) {
    return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  }

  const db = serviceClient()
  const { data: widget } = await db
    .from('scheduler_widget_instances')
    .select('id, is_active')
    .eq('api_key', widgetKey)
    .single()
  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })
  }

  let body: SignRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }
  if (!body.lead_id || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: 'lead_id and files are required' }, { status: 400, headers: cors })
  }

  const { data: lead } = await db
    .from('scheduler_leads')
    .select('id')
    .eq('id', body.lead_id)
    .single()
  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404, headers: cors })
  }

  const { data: limitRows } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', ['max_upload_files', 'max_upload_size_mb'])
  const limits: Record<string, number> = { max_upload_files: 5, max_upload_size_mb: 25 }
  for (const row of limitRows ?? []) {
    if (typeof row.value === 'number') limits[row.key] = row.value
  }

  const { count: existingCount } = await db
    .from('scheduler_lead_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', body.lead_id)

  if ((existingCount ?? 0) + body.files.length > limits.max_upload_files) {
    return NextResponse.json(
      { error: `Maximum ${limits.max_upload_files} files per booking` },
      { status: 400, headers: cors }
    )
  }

  const maxBytes = limits.max_upload_size_mb * 1024 * 1024
  const out: { name: string; path: string; uploadUrl: string; mime: string }[] = []

  for (const f of body.files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    const mime = f.type || EXT_MIME[ext] || ''
    if (!ALLOWED_MIME_TYPES.includes(mime)) {
      return NextResponse.json(
        { error: `File type not supported${mime ? ` (${mime})` : ''} — please use JPG, PNG, WebP, or HEIC photos.` },
        { status: 400, headers: cors }
      )
    }
    if (f.size > maxBytes) {
      return NextResponse.json(
        { error: `File exceeds ${limits.max_upload_size_mb} MB limit: ${f.name}` },
        { status: 400, headers: cors }
      )
    }

    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
    const path = `${body.lead_id}/${Date.now()}_${out.length}_${safe}`
    const { data: signed, error } = await db.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(path)
    if (error || !signed?.signedUrl) {
      console.error('[uploads/sign] signed upload url error:', error)
      return NextResponse.json({ error: 'Could not prepare upload — please try again' }, { status: 500, headers: cors })
    }
    out.push({ name: f.name, path, uploadUrl: signed.signedUrl, mime })
  }

  return NextResponse.json({ files: out }, { status: 200, headers: cors })
}
