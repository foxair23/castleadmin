import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandlerResult, QueueRowLike } from '@/lib/reputation/dispatcher'
import type { ReputationSettings } from '@/lib/reputation/settings'

// CSAT 2-day reminders (PRD §3). The reminder pass and the eligibility rules
// are added with the CSAT reminder change; this send handler is the queue's
// entry point.
export async function sendCsatReminder(_db: SupabaseClient, _row: QueueRowLike, _settings: ReputationSettings): Promise<HandlerResult> {
  return { ok: false, error: 'csat reminders are not wired yet', retry: false, cancel: true }
}
