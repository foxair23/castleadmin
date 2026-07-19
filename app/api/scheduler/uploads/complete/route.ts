import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Step 2 of the direct-to-storage upload flow (see ../sign/route.ts): after
// the widget PUTs a file to its signed upload URL, this records the attachment
// row and returns a viewable signed URL for the in-widget preview. The object
// must actually exist in storage (the signed-view creation fails otherwise),
// so a caller can't register phantom files.

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  /^http:\/\/localhost:\d+$/,
]

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

interface CompleteRequest {
  lead_id: string
  path: string
  filename: string
  mime: string
  size: number
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

  let body: CompleteRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }
  if (!body.lead_id || !body.path || !body.filename) {
    return NextResponse.json({ error: 'lead_id, path, and filename are required' }, { status: 400, headers: cors })
  }
  // The path is server-generated in /sign and always starts with the lead id —
  // reject anything else so a caller can't claim another lead's objects.
  if (!body.path.startsWith(`${body.lead_id}/`)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400, headers: cors })
  }

  // Verify the object really exists (signed-view creation fails for missing objects).
  const { data: signed, error: signErr } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(body.path, 60 * 60 * 24 * 7)
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: 'Upload not found — please try again' }, { status: 404, headers: cors })
  }

  const { error: dbError } = await db
    .from('scheduler_lead_attachments')
    .insert({
      lead_id: body.lead_id,
      filename: body.filename.slice(0, 255),
      storage_path: body.path,
      mime_type: body.mime || 'application/octet-stream',
      size_bytes: body.size ?? 0,
    })
  if (dbError) {
    console.error('[uploads/complete] DB insert error:', dbError)
    return NextResponse.json({ error: 'Could not record upload' }, { status: 500, headers: cors })
  }

  return NextResponse.json({ url: signed.signedUrl }, { status: 201, headers: cors })
}
