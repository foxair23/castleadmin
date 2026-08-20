import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'

// Login-gated media viewer for a scheduler lead's customer photos/videos.
// Linked (via a short URL) from Service Fusion job/estimate descriptions so the
// description stays clean. proxy.ts already requires login for this route (it's
// not public) and preserves ?next, so an unauthenticated click routes through
// /login and back here. Any authenticated Castle Admin user (admin, sales, tech)
// may view — there is no role layout above /media. Attachments are read with the
// service role (their RLS is admin-only) and signed fresh (1h) on each view, so
// no long-lived URLs ever leave the app.

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

const BUCKET = 'scheduler-uploads'

export default async function MediaPage({ params }: Props) {
  const { id } = await params

  // Belt-and-suspenders auth (proxy also gates this route).
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/media/${encodeURIComponent(id)}`)

  const adminDb = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: lead } = await adminDb
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_last_name, estimate_channel')
    .eq('id', id)
    .maybeSingle()

  const { data: rows } = await adminDb
    .from('scheduler_lead_attachments')
    .select('filename, storage_path, mime_type')
    .eq('lead_id', id)
    .order('uploaded_at', { ascending: true })

  const attachments: { filename: string; mime_type: string; url: string }[] = []
  for (const a of (rows ?? []) as { filename: string; storage_path: string; mime_type: string }[]) {
    const { data: signed } = await adminDb.storage.from(BUCKET).createSignedUrl(a.storage_path, 60 * 60)
    if (signed?.signedUrl) attachments.push({ filename: a.filename, mime_type: a.mime_type ?? '', url: signed.signedUrl })
  }

  const customerName = lead
    ? [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || '—'
    : null

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">Customer photos &amp; video</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {customerName ? `${customerName} · ` : ''}Lead {id}
          </p>
        </div>

        {!lead ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
            No record found for this link.
          </div>
        ) : attachments.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
            No photos or video were attached to this request.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {attachments.map((a, i) => {
              const isImage = a.mime_type.startsWith('image/')
              const isVideo = a.mime_type.startsWith('video/')
              return (
                <div key={i} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                  {isImage ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.url} alt={a.filename} className="w-full h-56 object-cover" />
                    </a>
                  ) : isVideo ? (
                    <video src={a.url} controls playsInline className="w-full h-56 object-cover bg-black" />
                  ) : (
                    <div className="h-56 flex items-center justify-center text-gray-400 text-sm">
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                        Download {a.filename}
                      </a>
                    </div>
                  )}
                  <div className="px-3 py-2 text-xs text-gray-500 truncate" title={a.filename}>
                    {a.filename}
                    {isVideo && <a href={a.url} target="_blank" rel="noopener noreferrer" className="ml-2 text-blue-600 underline">open</a>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="mt-6 text-xs text-gray-400">Links expire after 1 hour — reload this page to refresh them.</p>
      </div>
    </div>
  )
}
