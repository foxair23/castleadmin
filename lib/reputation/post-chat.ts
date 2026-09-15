import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLlmConfigured, describeLlmError } from '@/lib/agent/llm'
import { loadAgentSettings } from '@/lib/agent/settings'
import { addInstruction, retireInstruction } from '@/lib/agent/knowledge'
import { runCassieTurn, tidyHistory } from '@/lib/agent/chat/colleague'
import { getPostCharter, listPostInstructions, listPhotoInstructions, POST_CHANNEL, PHOTO_CHANNEL } from './knowledge'
import { PHOTO_SELECT, rescoreJobPhotos, type JobPhotoRow } from './photos'
import { redraftPost, setPostPhotos, setPhotoUsable } from './post-actions'

// The feedback rail beside a profile post. The office says what is wrong in plain
// words ("that's the old cracked door, not the finished work") and the agent acts:
// relabels a photo, blocks it, swaps the post's photos, redrafts the text, and
// saves a standing rule so the same mistake is not made next week.
//
// The thread is keyed to the JOB, not the post, so it survives a redraft or a
// second post for the same job — the same reason Cassie's review chat is keyed to
// the inbound email rather than the draft.
//
// Every change an agent turn makes is recorded in `meta.changes` with its previous
// value, so one button puts it all back.

const MAX_HISTORY = 24
const SHOWS = ['before', 'after', 'finished', 'other'] as const
type Shows = typeof SHOWS[number]

export interface ChatChange {
  kind: 'photo_shows' | 'photo_override' | 'post_photos' | 'post_text' | 'instruction'
  id: string
  from: unknown
  to: unknown
  label: string
}
export interface PostChatTurn {
  id: string; sf_job_id: string; post_id: string | null; role: 'user' | 'agent'
  text: string; user_name: string | null; created_at: string
  meta: { toolsUsed?: string[]; changes?: ChatChange[]; undone_at?: string | null }
}
const CHAT_SELECT = 'id, sf_job_id, post_id, role, text, user_name, meta, created_at'

export async function loadPostChat(db: SupabaseClient, sfJobId: string): Promise<PostChatTurn[]> {
  const { data } = await db.from('gbp_post_chat').select(CHAT_SELECT).eq('sf_job_id', sfJobId).order('created_at', { ascending: true }).limit(60)
  return (data ?? []) as PostChatTurn[]
}

async function say(db: SupabaseClient, row: { sfJobId: string; postId: string | null; role: 'user' | 'agent'; text: string; userName?: string | null; meta?: Record<string, unknown> }): Promise<PostChatTurn> {
  const { data, error } = await db.from('gbp_post_chat').insert({
    sf_job_id: row.sfJobId, post_id: row.postId, role: row.role, text: row.text, user_name: row.userName ?? null, meta: row.meta ?? {},
  }).select(CHAT_SELECT).single()
  if (error) throw new Error(error.message)
  return data as PostChatTurn
}

// ── Tools ───────────────────────────────────────────────────────────────────

const ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_photos', description: 'Every photo on this job as it stands now: number, label, score, reasons, and whether it is in the post. Call this before changing anything if you are unsure.',
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'relabel_photo', description: 'Correct what a photo shows when the scorer got it wrong (for example a damaged door labelled as finished work). Use the photo numbers from the list.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['photo_number', 'shows'],
      properties: {
        photo_number: { type: 'integer', description: 'The photo number as listed.' },
        shows: { type: 'string', enum: [...SHOWS], description: '"before" = the old or damaged state, "after" = the same spot finished, "finished" = finished work with no before shot, "other" = not the product.' },
      },
    },
  },
  {
    name: 'set_photo_usable', description: 'Force a photo to be allowed, block it from ever being posted, or clear that choice and go back to the score.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['photo_number', 'decision'],
      properties: { photo_number: { type: 'integer' }, decision: { type: 'string', enum: ['allow', 'block', 'reset'] } },
    },
  },
  {
    name: 'choose_photos', description: 'Set which photos this post carries: one photo, or a before/after pair in that order. Only photos with an image can be chosen.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['photo_numbers'],
      properties: { photo_numbers: { type: 'array', items: { type: 'integer' }, description: '1 or 2 photo numbers, in the order they should appear.' } },
    },
  },
  {
    name: 'revise_post', description: 'Rewrite the post text, following the charter and the standing rules. Say in the note what should change.',
    input_schema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', description: 'What to change, in one or two sentences.' } } },
  },
  {
    name: 'rescore_photos', description: 'Look at every photo on this job again from scratch. Use after saving a rule about photos, so the new rule is applied to this job. Allow/block choices are kept.',
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'remember_rule', description: 'Save a standing rule so this correction holds for every future job. Keep it one sentence, general, and about the pattern rather than this one photo.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['text', 'applies_to'],
      properties: {
        text: { type: 'string', description: 'The rule, one sentence, written as an instruction.' },
        applies_to: { type: 'string', enum: ['photos', 'posts'], description: '"photos" = how photos are judged and labelled. "posts" = how the post text is written.' },
      },
    },
  },
]

// ── Context ─────────────────────────────────────────────────────────────────

export interface PostChatContext {
  sfJobId: string
  post: { id: string; status: string; draft_text: string; final_text: string | null; photo_ids: string[] } | null
  job: { number: string | null; category: string | null; city: string | null; description: string | null; work_completed_at: string | null } | null
  photos: JobPhotoRow[]
}

export async function loadPostChatContext(db: SupabaseClient, sfJobId: string, postId: string | null): Promise<PostChatContext> {
  const [{ data: post }, { data: job }, { data: photos }] = await Promise.all([
    postId
      ? db.from('gbp_posts').select('id, status, draft_text, final_text, photo_ids').eq('id', postId).maybeSingle()
      : db.from('gbp_posts').select('id, status, draft_text, final_text, photo_ids').eq('sf_job_id', sfJobId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('sf_jobs').select('number, category, city, description, work_completed_at').eq('id', sfJobId).maybeSingle(),
    db.from('job_photos').select(PHOTO_SELECT).eq('sf_job_id', sfJobId).order('created_at', { ascending: true }),
  ])
  return {
    sfJobId,
    post: (post ?? null) as PostChatContext['post'],
    job: (job ?? null) as PostChatContext['job'],
    photos: (photos ?? []) as JobPhotoRow[],
  }
}

/** Pure: the numbered photo list the model reads and refers to by number. */
export function photoLines(photos: JobPhotoRow[], chosen: string[]): string {
  if (!photos.length) return 'No photos have been pulled in for this job.'
  return photos.map((p, i) => {
    const bits = [
      `#${i + 1}`,
      p.shows ? `labelled ${p.shows}` : 'not scored yet',
      p.score == null ? 'no score' : `score ${p.score}`,
      p.subject ? `shows "${p.subject}"` : null,
      chosen.includes(p.id) ? `IN THIS POST (position ${chosen.indexOf(p.id) + 1})` : null,
      p.override_usable === true ? 'forced allowed by a person' : p.override_usable === false ? 'blocked by a person' : null,
      p.pair_id ? `paired with another shot of the same spot` : null,
      !p.public_url ? 'no image (not imported)' : null,
      p.score_reasons?.length ? `scorer said: ${p.score_reasons.join('; ')}` : null,
    ].filter(Boolean)
    return `- ${bits.join(' · ')}`
  }).join('\n')
}

function systemPrompt(ctx: PostChatContext, charter: string, postRules: string[], photoRules: string[], userName: string): string {
  const j = ctx.job
  const text = ctx.post ? (ctx.post.final_text ?? ctx.post.draft_text) : null
  return [
    `You are the posting assistant for Castle Garage Doors & Gates. ${userName} is looking at a Google Business Profile post you drafted from a finished job and is telling you what is wrong with it.`,
    `Act on what they say rather than only agreeing: correct a photo's label, block a photo, change which photos the post carries, rewrite the text. Use the tools; never claim to have changed something you did not.`,
    `When a correction is a pattern that will come up again, save a rule with remember_rule as well as fixing this post. One rule per correction, one sentence, about the pattern. Do not save a rule for a one-off.`,
    `After a photo rule is saved, call rescore_photos so this job is judged by it too.`,
    `Reply in one short paragraph, plain words, no lists. Say what you changed and what you saved. If you could not do something, say so plainly.`,
    `Never put a technician's or customer's name, a house number, or an address in a post.`,
    '',
    `THE JOB: ${j?.category ?? 'unknown type'}${j?.city ? ` in ${j.city}` : ''}, job ${j?.number ?? ctx.sfJobId}.${j?.description ? ` Work: ${j.description.slice(0, 400)}` : ''}`,
    ctx.post ? `THE POST (${ctx.post.status}):\n${text}` : 'There is no post for this job right now.',
    '',
    `THE PHOTOS:\n${photoLines(ctx.photos, ctx.post?.photo_ids ?? [])}`,
    '',
    `POST CHARTER:\n${charter.slice(0, 4000)}`,
    postRules.length ? `STANDING RULES FOR POST TEXT:\n${postRules.map(r => `- ${r}`).join('\n')}` : '',
    photoRules.length ? `STANDING RULES FOR PHOTOS:\n${photoRules.map(r => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

// ── One turn ────────────────────────────────────────────────────────────────

export interface ChatInput { sfJobId: string; postId: string | null; text: string; user: { id: string | null; name: string } }

export async function chatAboutPost(db: SupabaseClient, input: ChatInput): Promise<{ turns: PostChatTurn[] }> {
  const { sfJobId, postId, text, user } = input
  await say(db, { sfJobId, postId, role: 'user', text: text.trim(), userName: user.name })
  if (!isLlmConfigured()) {
    await say(db, { sfJobId, postId, role: 'agent', text: 'I cannot answer right now: this app has no Anthropic API key set, so nothing can be drafted or scored.' })
    return { turns: await loadPostChat(db, sfJobId) }
  }

  const ctx = await loadPostChatContext(db, sfJobId, postId)
  const [settings, charter, postRules, photoRules] = await Promise.all([
    loadAgentSettings(db), getPostCharter(db), listPostInstructions(db), listPhotoInstructions(db),
  ])

  const byNumber = (n: unknown): JobPhotoRow | null => {
    const i = Number(n)
    return Number.isInteger(i) && i >= 1 && i <= ctx.photos.length ? ctx.photos[i - 1] : null
  }
  const numberOf = (id: string) => ctx.photos.findIndex(p => p.id === id) + 1
  const changes: ChatChange[] = []

  const runTool = async (name: string, toolInput: Record<string, unknown>): Promise<string> => {
    if (name === 'list_photos') {
      const fresh = await loadPostChatContext(db, sfJobId, ctx.post?.id ?? null)
      return photoLines(fresh.photos, fresh.post?.photo_ids ?? [])
    }
    if (name === 'relabel_photo') {
      const p = byNumber(toolInput.photo_number)
      if (!p) return `There is no photo #${toolInput.photo_number}; there are ${ctx.photos.length}.`
      const shows = SHOWS.includes(toolInput.shows as Shows) ? (toolInput.shows as Shows) : null
      if (!shows) return 'shows must be before, after, finished or other.'
      await db.from('job_photos').update({ shows, updated_at: new Date().toISOString() }).eq('id', p.id)
      changes.push({ kind: 'photo_shows', id: p.id, from: p.shows, to: shows, label: `photo ${numberOf(p.id)} relabelled ${p.shows ?? 'unscored'} → ${shows}` })
      return `Photo ${numberOf(p.id)} is now labelled "${shows}".`
    }
    if (name === 'set_photo_usable') {
      const p = byNumber(toolInput.photo_number)
      if (!p) return `There is no photo #${toolInput.photo_number}.`
      const d = String(toolInput.decision)
      const v = d === 'allow' ? true : d === 'block' ? false : null
      await setPhotoUsable(db, p.id, v)
      changes.push({ kind: 'photo_override', id: p.id, from: p.override_usable, to: v, label: `photo ${numberOf(p.id)} ${d === 'reset' ? 'back to its score' : d + 'ed'}` })
      return `Photo ${numberOf(p.id)} is ${d === 'allow' ? 'allowed' : d === 'block' ? 'blocked from every post' : 'back to whatever its score says'}.`
    }
    if (name === 'choose_photos') {
      if (!ctx.post) return 'There is no post for this job to put photos on.'
      const nums = Array.isArray(toolInput.photo_numbers) ? toolInput.photo_numbers : []
      const picked = nums.map(byNumber).filter((p): p is JobPhotoRow => !!p && !!p.public_url)
      if (!picked.length) return 'None of those photo numbers have an image I can use.'
      const ids = picked.slice(0, 2).map(p => p.id)
      const r = await setPostPhotos(db, ctx.post.id, ids)
      if (!r.ok) return `Could not change the photos: ${r.error}`
      changes.push({ kind: 'post_photos', id: ctx.post.id, from: ctx.post.photo_ids, to: ids, label: `post now carries photo ${ids.map(numberOf).join(' and ')}` })
      ctx.post.photo_ids = ids
      return `The post now carries photo ${ids.map(numberOf).join(' and ')}.`
    }
    if (name === 'revise_post') {
      if (!ctx.post) return 'There is no post for this job to rewrite.'
      const before = ctx.post.final_text ?? ctx.post.draft_text
      const r = await redraftPost(db, ctx.post.id, String(toolInput.note ?? '').slice(0, 500))
      if (!r.ok) return `Could not rewrite it: ${r.error}`
      changes.push({ kind: 'post_text', id: ctx.post.id, from: before, to: r.text, label: 'post text rewritten' })
      ctx.post.draft_text = r.text; ctx.post.final_text = null
      return `New text:\n${r.text}`
    }
    if (name === 'rescore_photos') {
      const r = await rescoreJobPhotos(db, sfJobId, settings.composer_model, { category: ctx.job?.category, description: ctx.job?.description })
      if (r.error) return `Could not score them again: ${r.error}`
      const fresh = await loadPostChatContext(db, sfJobId, ctx.post?.id ?? null)
      ctx.photos = fresh.photos
      return `Scored ${r.scored} photo(s) again.\n${photoLines(fresh.photos, fresh.post?.photo_ids ?? [])}`
    }
    if (name === 'remember_rule') {
      const ruleText = String(toolInput.text ?? '').trim()
      if (!ruleText) return 'Give me the rule to save.'
      const channel = toolInput.applies_to === 'posts' ? POST_CHANNEL : PHOTO_CHANNEL
      const saved = await addInstruction(db, ruleText.slice(0, 500), channel, user.id)
      changes.push({ kind: 'instruction', id: saved.id, from: null, to: ruleText, label: `rule saved for ${channel === POST_CHANNEL ? 'post text' : 'photos'}: "${ruleText}"` })
      return `Saved as a standing rule for ${channel === POST_CHANNEL ? 'writing posts' : 'judging photos'}. It applies from now on.`
    }
    return `unknown tool ${name}`
  }

  const history = await loadPostChat(db, sfJobId)
  const messages = history.slice(-MAX_HISTORY).map(t => ({
    role: t.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: t.role === 'user' ? `${t.user_name ?? 'The office'}: ${t.text}` : t.text,
  }))

  const turn = await runCassieTurn({
    model: settings.composer_model,
    system: systemPrompt(ctx, charter.body, postRules.map(r => r.text), photoRules.map(r => r.text), user.name),
    messages: tidyHistory(messages),
    tools: ACTION_TOOLS,
    runTool,
    maxRounds: 6,
  })

  const body = turn.error
    ? `I hit a snag: ${turn.error}${changes.length ? ` I did make these changes first: ${changes.map(c => c.label).join('; ')}.` : ''}`
    : turn.text || (changes.length ? `Done: ${changes.map(c => c.label).join('; ')}.` : 'I did not change anything.')
  await say(db, { sfJobId, postId: ctx.post?.id ?? postId, role: 'agent', text: body, meta: { toolsUsed: turn.toolsUsed, changes } })
  return { turns: await loadPostChat(db, sfJobId) }
}

// ── Undo ────────────────────────────────────────────────────────────────────

/** Put back everything one agent turn changed. Safe to call once; the turn is then marked undone. */
export async function undoPostChatTurn(db: SupabaseClient, turnId: string, userId: string | null): Promise<{ ok: true; undone: number; sfJobId: string } | { ok: false; error: string }> {
  const { data } = await db.from('gbp_post_chat').select(CHAT_SELECT).eq('id', turnId).maybeSingle()
  const turn = data as PostChatTurn | null
  if (!turn) return { ok: false, error: 'That message is gone.' }
  if (turn.meta?.undone_at) return { ok: false, error: 'That change was already put back.' }
  const changes = turn.meta?.changes ?? []
  if (!changes.length) return { ok: false, error: 'That message did not change anything.' }
  const nowIso = new Date().toISOString()
  let undone = 0
  for (const c of changes) {
    if (c.kind === 'photo_shows') await db.from('job_photos').update({ shows: c.from as string | null, updated_at: nowIso }).eq('id', c.id)
    else if (c.kind === 'photo_override') await setPhotoUsable(db, c.id, c.from as boolean | null)
    else if (c.kind === 'post_photos') await db.from('gbp_posts').update({ photo_ids: c.from as string[], updated_at: nowIso }).eq('id', c.id)
    else if (c.kind === 'post_text') await db.from('gbp_posts').update({ draft_text: c.from as string, final_text: null, updated_at: nowIso }).eq('id', c.id)
    else if (c.kind === 'instruction') await retireInstruction(db, c.id, userId)
    undone++
  }
  await db.from('gbp_post_chat').update({ meta: { ...turn.meta, undone_at: nowIso } }).eq('id', turnId)
  await say(db, { sfJobId: turn.sf_job_id, postId: turn.post_id, role: 'agent', text: `Put back: ${changes.map(c => c.label).join('; ')}.` })
  return { ok: true, undone, sfJobId: turn.sf_job_id }
}

export { describeLlmError }
