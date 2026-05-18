import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  /^http:\/\/localhost:\d+$/,
]

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
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
    'Access-Control-Allow-Headers': 'X-Castle-Widget-Key',
  }
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // Widget key auth
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

  // Fetch upload limits from settings
  const { data: limitRows } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', ['max_upload_files', 'max_upload_size_mb'])

  const limits: Record<string, number> = { max_upload_files: 5, max_upload_size_mb: 25 }
  for (const row of limitRows ?? []) {
    if (typeof row.value === 'number') limits[row.key] = row.value
  }

  // Parse multipart form data
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400, headers: cors })
  }

  const leadId = formData.get('lead_id')
  if (!leadId || typeof leadId !== 'string') {
    return NextResponse.json({ error: 'Missing lead_id' }, { status: 400, headers: cors })
  }

  // Validate lead exists
  const { data: lead } = await db
    .from('scheduler_leads')
    .select('id')
    .eq('id', leadId)
    .single()

  if (!lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404, headers: cors })
  }

  // Count existing attachments
  const { count: existingCount } = await db
    .from('scheduler_lead_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)

  const files = formData.getAll('files') as File[]
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400, headers: cors })
  }

  const totalAfter = (existingCount ?? 0) + files.length
  if (totalAfter > limits.max_upload_files) {
    return NextResponse.json(
      { error: `Maximum ${limits.max_upload_files} files per booking` },
      { status: 400, headers: cors }
    )
  }

  const maxBytes = limits.max_upload_size_mb * 1024 * 1024
  const results: { filename: string; storage_path: string; url: string }[] = []

  for (const file of files) {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `File type not allowed: ${file.type}` },
        { status: 400, headers: cors }
      )
    }
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `File exceeds ${limits.max_upload_size_mb} MB limit: ${file.name}` },
        { status: 400, headers: cors }
      )
    }

    // Sanitize filename
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
    const storagePath = `${leadId}/${Date.now()}_${safe}`

    const bytes = await file.arrayBuffer()

    const { error: uploadError } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error('[uploads] Storage upload error:', uploadError)
      return NextResponse.json(
        { error: 'Upload failed — please try again' },
        { status: 500, headers: cors }
      )
    }

    // Insert attachment record
    const { error: dbError } = await db
      .from('scheduler_lead_attachments')
      .insert({
        lead_id: leadId,
        filename: file.name.slice(0, 255),
        storage_path: storagePath,
        mime_type: file.type,
        size_bytes: file.size,
      })

    if (dbError) {
      console.error('[uploads] DB insert error:', dbError)
      // Storage was uploaded, but record failed — log and continue (non-fatal)
    }

    // Generate short-lived signed URL (7 days) for returning to client
    const { data: signed } = await db.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7)

    results.push({
      filename: file.name,
      storage_path: storagePath,
      url: signed?.signedUrl ?? '',
    })
  }

  return NextResponse.json({ uploads: results }, { status: 201, headers: cors })
}
