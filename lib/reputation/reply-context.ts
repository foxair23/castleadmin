import type { SupabaseClient } from '@supabase/supabase-js'
import { scrubNames, serviceTermsFor, type GuardrailContext } from './guardrails'
import { bandFor, type ReplyBand } from './settings'

// What the drafter is allowed to know about a review (PRD §4.2 step 3). Job
// facts come only from a confident match; technician names are never loaded
// into the context and are scrubbed out of job notes.

export interface ReviewForContext {
  id: string
  reviewer_name: string | null
  star_rating: number
  comment: string | null
  created_at_google: string
  matched_job_id: string | null
  match_status: string
  ai_neighborhood?: string | null
  ai_mentioned_names?: string[] | null
}

export interface ReplyJobFacts {
  category: string | null
  description: string | null
  completionNotes: string | null
  items: string[]
  city: string | null
  postalCode: string | null
}

export interface ReplyContext {
  band: ReplyBand
  reviewerFirstName: string | null
  starRating: number
  comment: string | null
  reviewAgeDays: number
  hasJob: boolean
  job: ReplyJobFacts | null
  guardrail: Omit<GuardrailContext, 'band' | 'hasJob' | 'roster' | 'signature' | 'reviewerName' | 'mentionedNames'>
}

const ANON = [/^a google user$/i, /^google user$/i, /^anonymous$/i]

export function reviewerFirstNameOf(name: string | null): string | null {
  if (!name || ANON.some(p => p.test(name.trim()))) return null
  const first = name.trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, '')
  return first && first.length >= 2 ? first : null
}

export async function buildReplyContext(db: SupabaseClient, review: ReviewForContext, roster: string[]): Promise<ReplyContext> {
  const confident = review.matched_job_id && (review.match_status === 'auto' || review.match_status === 'confirmed')
  let job: ReplyJobFacts | null = null
  let customerName: string | null = null, contactLastName: string | null = null, street: string | null = null
  if (confident) {
    const [{ data: j }, { data: items }] = await Promise.all([
      db.from('sf_jobs').select('category, description, completion_notes, customer_name, contact_last_name, street_1, city, postal_code').eq('id', review.matched_job_id!).maybeSingle(),
      db.from('sf_job_items').select('name').eq('sf_job_id', review.matched_job_id!).limit(20),
    ])
    const row = j as { category: string | null; description: string | null; completion_notes: string | null; customer_name: string | null; contact_last_name: string | null; street_1: string | null; city: string | null; postal_code: string | null } | null
    if (row) {
      job = {
        category: row.category,
        description: scrubNames(row.description, roster),
        completionNotes: scrubNames(row.completion_notes, roster),
        items: ((items ?? []) as Array<{ name: string | null }>).map(i => i.name?.trim() ?? '').filter(Boolean),
        city: row.city, postalCode: row.postal_code,
      }
      customerName = row.customer_name; contactLastName = row.contact_last_name; street = row.street_1
    }
  }
  const ageDays = Math.max(0, Math.round((Date.now() - new Date(review.created_at_google).getTime()) / 86_400_000))
  return {
    band: bandFor(review.star_rating),
    reviewerFirstName: reviewerFirstNameOf(review.reviewer_name),
    starRating: review.star_rating,
    comment: review.comment?.trim() || null,
    reviewAgeDays: ageDays,
    hasJob: !!job,
    job,
    guardrail: {
      customerName, contactLastName, street,
      serviceTerms: job ? serviceTermsFor(job.category, job.items) : [],
      city: job?.city ?? null,
      neighborhood: review.ai_neighborhood ?? null,
    },
  }
}
