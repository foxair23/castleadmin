// One normalised shape for an inbound email, whatever brought it in (Gmail poll,
// an admin "replay" paste, a regression fixture). Everything downstream — filters,
// classification, composition — works on this and never on a provider payload.

export interface EmailAddress { addr: string; name: string | null }

export interface InboundEmail {
  source: 'gmail' | 'replay'
  gmailMessageId: string | null
  gmailThreadId: string | null
  internetMessageId: string | null
  inReplyTo: string | null
  references: string[]
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  /** Plain text body (HTML already stripped by the fetcher). May include quoted history. */
  bodyText: string
  /** Header names lower-cased. Only the ones we filter on need to be present. */
  headers: Record<string, string>
  receivedAt: string
  /** Set when the message reached us through the office Google Group (info@): `from` is
   *  the partner's real address, restored from the relay headers; this is the group. */
  relayedVia?: string | null
}

/** What we know about the thread before this message arrived. */
export interface ThreadState {
  /** Cassie has already replied (sent) in this thread. */
  agentReplied: boolean
  /** A Castle person has written in this thread after the last partner message. */
  humanRepliedAfterInquiry: boolean
  /** Number of prior inbound partner messages in the thread. */
  priorInbound: number
}

export type DropReason =
  | 'processing_off'
  | 'not_allowlisted'
  | 'blocklisted'
  | 'noreply_sender'
  | 'auto_reply'
  | 'bulk_mail'
  | 'own_address'
  | 'empty_body'
  | 'thread_actioned'
  | 'human_replied'

export type FilterResult =
  | { pass: true; deliveryPath: 'direct' | 'distribution' }
  | { pass: false; reason: DropReason; detail: string }
  /** Not a drop and not an inquiry: a Castle person wrote in the thread. Recorded for thread state. */
  | { pass: false; reason: 'human_reply'; detail: string }
