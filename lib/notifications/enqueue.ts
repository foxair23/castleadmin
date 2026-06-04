import { createClient } from '@supabase/supabase-js'

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

interface EnqueueRow {
  user_id: string
  notification_type_id: string
  related_entity_type: string | null
  related_entity_id: string | null
  subject: string
  body_html: string
  body_text: string
  payload: Record<string, unknown> | null
  status: string
  send_after: string
}

async function getTypeId(key: string): Promise<string | null> {
  const { data } = await db()
    .from('notification_types')
    .select('id')
    .eq('key', key)
    .eq('is_active', true)
    .single()
  return data?.id ?? null
}

/** Enqueue a notification for a single user. Returns false if the type is inactive. */
export async function enqueueNotification(params: {
  notificationTypeKey: string
  userId: string
  subject: string
  bodyHtml: string
  bodyText: string
  relatedEntityType?: string
  relatedEntityId?: string
  payload?: Record<string, unknown>
  sendAfter?: Date
}): Promise<boolean> {
  const supabase = db()
  const typeId = await getTypeId(params.notificationTypeKey)
  if (!typeId) return false

  await supabase.from('notification_log').insert({
    user_id: params.userId,
    notification_type_id: typeId,
    related_entity_type: params.relatedEntityType ?? null,
    related_entity_id: params.relatedEntityId ?? null,
    subject: params.subject,
    body_html: params.bodyHtml,
    body_text: params.bodyText,
    payload: params.payload ?? null,
    status: 'queued',
    send_after: (params.sendAfter ?? new Date()).toISOString(),
  } satisfies Partial<EnqueueRow>)

  return true
}

/**
 * Enqueue a notification for every subscriber of the given type.
 * Returns the number of rows inserted.
 */
export async function enqueueForSubscribers(params: {
  notificationTypeKey: string
  subject: string
  bodyHtml: string
  bodyText: string
  relatedEntityType?: string
  relatedEntityId?: string
  payload?: Record<string, unknown>
  sendAfter?: Date
}): Promise<number> {
  const supabase = db()
  const typeId = await getTypeId(params.notificationTypeKey)
  if (!typeId) return 0

  const { data: prefs } = await supabase
    .from('user_notification_preferences')
    .select('user_id')
    .eq('notification_type_id', typeId)
    .eq('is_enabled', true)

  if (!prefs || prefs.length === 0) return 0

  const sendAfterIso = (params.sendAfter ?? new Date()).toISOString()
  const rows: Partial<EnqueueRow>[] = prefs.map(p => ({
    user_id: p.user_id,
    notification_type_id: typeId,
    related_entity_type: params.relatedEntityType ?? null,
    related_entity_id: params.relatedEntityId ?? null,
    subject: params.subject,
    body_html: params.bodyHtml,
    body_text: params.bodyText,
    payload: params.payload ?? null,
    status: 'queued',
    send_after: sendAfterIso,
  }))

  await supabase.from('notification_log').insert(rows)
  return rows.length
}

/**
 * Enqueue a notification for a single user, but only if they have the preference enabled.
 * Returns false if the type is inactive or the user has the preference disabled.
 */
export async function enqueueForUserIfEnabled(params: {
  notificationTypeKey: string
  userId: string
  subject: string
  bodyHtml: string
  bodyText: string
  relatedEntityType?: string
  relatedEntityId?: string
  payload?: Record<string, unknown>
  sendAfter?: Date
}): Promise<boolean> {
  const supabase = db()
  const typeId = await getTypeId(params.notificationTypeKey)
  if (!typeId) return false

  const { data: pref } = await supabase
    .from('user_notification_preferences')
    .select('is_enabled')
    .eq('user_id', params.userId)
    .eq('notification_type_id', typeId)
    .single()

  if (!pref?.is_enabled) return false

  await supabase.from('notification_log').insert({
    user_id: params.userId,
    notification_type_id: typeId,
    related_entity_type: params.relatedEntityType ?? null,
    related_entity_id: params.relatedEntityId ?? null,
    subject: params.subject,
    body_html: params.bodyHtml,
    body_text: params.bodyText,
    payload: params.payload ?? null,
    status: 'queued',
    send_after: (params.sendAfter ?? new Date()).toISOString(),
  } satisfies Partial<EnqueueRow>)

  return true
}

/**
 * Check if a notification for a given entity was already enqueued/sent recently.
 * Used for dedup (e.g. one scheduler_lead_stuck per lead, one sync_not_run per 24h).
 */
export async function hasRecentNotification(params: {
  notificationTypeKey: string
  relatedEntityType?: string
  relatedEntityId?: string
  withinHours: number
}): Promise<boolean> {
  const supabase = db()
  const typeId = await getTypeId(params.notificationTypeKey)
  if (!typeId) return false

  const cutoff = new Date(Date.now() - params.withinHours * 3_600_000).toISOString()

  let query = supabase
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .eq('notification_type_id', typeId)
    .in('status', ['queued', 'sending', 'sent'])
    .gte('created_at', cutoff)

  if (params.relatedEntityType) {
    query = query.eq('related_entity_type', params.relatedEntityType)
  }
  if (params.relatedEntityId) {
    query = query.eq('related_entity_id', params.relatedEntityId)
  }

  const { count } = await query
  return (count ?? 0) > 0
}
