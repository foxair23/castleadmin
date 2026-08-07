import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Server side of the "post a note to the SF job" flow. Service Fusion has no
// public API to add a note to an existing job, so the actual posting is done by
// the browser extension driving SF's web form (POST /jobs/addNewNoteAjax) in the
// user's logged-in session. This module is the queue the extension reads and the
// callback it writes back to — the app stays the source of truth (what note, on
// which job, idempotency, audit); the extension is only the arm that posts.
//
// State machine (status): pending → posted | failed.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface EnqueueNoteInput {
  /** Numeric SF job id (sf_jobs.id) — posted verbatim as addNewNoteAjax's `id`. */
  sfJobId: string
  noteText: string
  event: string                 // 'invoice_reminder' | future sources
  /** Stable key so retries never double-post. Omit to allow duplicates. */
  dedupKey?: string
  refTable?: string
  refId?: string
}

/**
 * Queue a note to be posted to an SF job. Idempotent when `dedupKey` is given:
 * a repeat enqueue with the same key is a no-op (the note is posted at most
 * once). Never throws — enqueuing a note must not break the action that
 * triggered it (e.g. an invoice reminder still counts as sent even if the audit
 * note can't be queued); failures are swallowed and returned as { ok:false }.
 */
export async function enqueueNote(input: EnqueueNoteInput): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!input.sfJobId || !input.noteText) return { ok: false, error: 'sfJobId and noteText required' }
  try {
    const supabase = db()
    if (input.dedupKey) {
      // Dedup at the DB level via the unique index; ignoreDuplicates makes a
      // repeat a silent no-op rather than an error.
      const { error } = await supabase
        .from('sf_note_queue')
        .upsert(
          { sf_job_id: input.sfJobId, note_text: input.noteText, event: input.event, dedup_key: input.dedupKey, ref_table: input.refTable ?? null, ref_id: input.refId ?? null },
          { onConflict: 'dedup_key', ignoreDuplicates: true },
        )
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    }
    const { error } = await supabase
      .from('sf_note_queue')
      .insert({ sf_job_id: input.sfJobId, note_text: input.noteText, event: input.event, ref_table: input.refTable ?? null, ref_id: input.refId ?? null })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface NoteQueueItem {
  id: string
  /** Internal SF job id — the value posted to addNewNoteAjax. */
  sfJobId: string
  /** Human-readable job number (sf_jobs.number) for display/reporting. Falls
   *  back to the internal id if the job isn't in the mirror. */
  jobNumber: string
  noteText: string
  event: string
}

/** Pending notes the browser extension should post to SF. */
export async function getNoteQueue(): Promise<{ items: NoteQueueItem[] }> {
  const supabase = db()
  const { data } = await supabase
    .from('sf_note_queue')
    .select('id, sf_job_id, note_text, event')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(200)
  const rows = (data ?? []) as Array<{ id: string; sf_job_id: string; note_text: string; event: string }>

  // Resolve the readable job number for each queued note so the extension can
  // report by the number the office recognizes (not the internal id it posts to).
  const jobIds = [...new Set(rows.map(r => r.sf_job_id))]
  const { data: jobs } = await supabase.from('sf_jobs').select('id, number').in('id', jobIds.length ? jobIds : ['__none__'])
  const numberById = new Map(((jobs ?? []) as Array<{ id: string; number: string | null }>).map(j => [j.id, j.number]))

  const items = rows.map(r => ({
    id: r.id,
    sfJobId: r.sf_job_id,
    jobNumber: numberById.get(r.sf_job_id) || r.sf_job_id,
    noteText: r.note_text,
    event: r.event,
  }))
  return { items }
}

/** Extension callback: record the outcome of posting one note to SF. */
export async function recordNoteResult(id: string, result: { ok: boolean; sfResponse?: unknown; error?: string }): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: guard } = await supabase.from('sf_note_queue').select('status, attempts').eq('id', id).maybeSingle()
  if (!guard) return { ok: false, error: 'note not found' }
  if (guard.status === 'posted') return { ok: true } // idempotent — already recorded

  const attempts = (guard as { attempts: number }).attempts + 1
  const update: Record<string, unknown> = result.ok
    ? { status: 'posted', posted_at: new Date().toISOString(), sf_note_response: result.sfResponse ?? null, error: null, attempts }
    : { status: 'failed', error: result.error ?? 'unknown error', attempts }
  await supabase.from('sf_note_queue').update(update).eq('id', id).neq('status', 'posted')
  return { ok: true }
}
