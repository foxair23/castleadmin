import { type SupabaseClient } from '@supabase/supabase-js'
import { ensureShortLink } from '@/lib/short-links'

// A single short, login-gated link to a scheduler lead's customer photos/videos,
// for embedding in Service Fusion job/estimate descriptions instead of a wall of
// long signed URLs. The short link redirects to /media/<leadId> (login-gated,
// any Castle Admin role), which signs the media fresh on each view.

function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://hq.castlegaragedoors.com').replace(/\/+$/, '')
}

/** How many attachments a lead has (photos + video). */
export async function leadAttachmentCount(db: SupabaseClient, leadId: string): Promise<number> {
  const { count } = await db
    .from('scheduler_lead_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
  return count ?? 0
}

/** Short URL to the lead's media viewer (e.g. go.cstle.co/Ab12Cd34). */
export async function getMediaShortLink(leadId: string): Promise<string> {
  return ensureShortLink(`${appBase()}/media/${leadId}`)
}
