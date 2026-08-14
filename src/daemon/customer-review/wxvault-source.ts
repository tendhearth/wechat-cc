import { createHash } from 'node:crypto'
import type {
  CustomerChatSource,
  CustomerContact,
  CustomerMessage,
  CustomerMessageQuery,
} from './types'

export interface WxvaultToolBridge {
  call(tool: string, input?: unknown): Promise<string>
}

export interface WxvaultConversation {
  conversation?: unknown
  username?: unknown
  kind?: unknown
  last_time?: unknown
  preview?: unknown
}

export interface WxvaultMessage {
  time?: unknown
  sender?: unknown
  type?: unknown
  text?: unknown
  file?: unknown
}

export interface WxvaultMessagesResponse {
  conversation?: unknown
  username?: unknown
  kind?: unknown
  count?: unknown
  messages?: unknown
  error?: unknown
  ambiguous?: unknown
  hint?: unknown
}

export type CustomerChatSourceErrorCode =
  | 'WXVAULT_ERROR'
  | 'RANGE_TOO_LARGE'
  | 'AMBIGUOUS_CONTACT'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_CONVERSATION'
  | 'INVALID_TIME'

export class CustomerChatSourceError extends Error {
  constructor(
    readonly code: CustomerChatSourceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CustomerChatSourceError'
  }
}

function parsePluginJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Do not include `text`: an MCP transport failure can concatenate private
    // message output with malformed JSON.
    throw new CustomerChatSourceError('INVALID_RESPONSE', 'wxvault returned invalid JSON')
  }
}

/** Messages fetched per wxvault call while paging a range. */
const PAGE_SIZE = 2000

/**
 * Upper bound on a single review's message count. Past this we stop and ask
 * the owner to narrow the range instead of analyzing a silent prefix — every
 * message becomes LLM input, so an unbounded range is unbounded cost too.
 */
const HARD_MESSAGE_CAP = 20_000

const LOCAL_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** wxvault emits local wall-clock strings; keep them local rather than inventing an offset. */
export function normalizeWxvaultTime(value: unknown): string {
  const raw = stringValue(value)
  const match = LOCAL_TIME_RE.exec(raw)
  if (!match) {
    throw new CustomerChatSourceError('INVALID_TIME', 'wxvault returned an invalid message time')
  }
  const normalized = `${match[1]}T${match[2]}`
  const parsed = new Date(`${normalized}Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== normalized) {
    throw new CustomerChatSourceError('INVALID_TIME', 'wxvault returned an invalid message time')
  }
  return normalized
}

function normalizeBoundary(value: string, edge: 'from' | 'to'): string {
  const raw = value.trim()
  if (DATE_RE.test(raw)) return `${raw}T${edge === 'from' ? '00:00:00' : '23:59:59'}`
  return normalizeWxvaultTime(raw)
}

function wxvaultBoundary(value: string, edge: 'from' | 'to'): string {
  // wxvault interprets a bare date as local midnight for BOTH after and before.
  // Expand date-only product ranges so `to: 2026-07-13` includes that full day.
  return normalizeBoundary(value, edge).replace('T', ' ')
}

function filePath(file: unknown): string | undefined {
  if (!file || typeof file !== 'object') return undefined
  const path = stringValue((file as Record<string, unknown>).path)
  return path || undefined
}

export function createEvidenceKey(input: {
  conversationId: string
  time: string
  sender: string
  type: string
  text: string
}): string {
  // Length-prefix fields so values containing separators cannot create an
  // accidental equivalent serialization. 24 hex chars = 96 bits.
  const serialized = [input.conversationId, input.time, input.sender, input.type, input.text]
    .map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('|')
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 24)
}

/** First-version product scope: only one-to-one WeChat conversations. */
export function normalizeWxvaultConversation(raw: WxvaultConversation): CustomerContact | null {
  if (stringValue(raw.kind) !== '单聊') return null
  const id = stringValue(raw.username)
  const displayName = stringValue(raw.conversation)
  if (!id || !displayName) return null

  const lastMessageAtRaw = stringValue(raw.last_time)
  const preview = stringValue(raw.preview)
  return {
    id,
    displayName,
    kind: 'private',
    ...(lastMessageAtRaw ? { lastMessageAt: normalizeWxvaultTime(lastMessageAtRaw) } : {}),
    ...(preview ? { preview } : {}),
  }
}

export function normalizeWxvaultMessage(
  raw: WxvaultMessage,
  context: { conversationId: string; ownerLabel?: string },
): CustomerMessage {
  const time = normalizeWxvaultTime(raw.time)
  const sender = stringValue(raw.sender) || '未知发送者'
  const type = stringValue(raw.type) || 'unknown'
  const text = stringValue(raw.text)
  const path = filePath(raw.file)
  const evidenceKey = createEvidenceKey({
    conversationId: context.conversationId,
    time,
    sender,
    type,
    text,
  })

  return {
    evidenceKey,
    conversationId: context.conversationId,
    time,
    sender,
    isFromMe: sender === (context.ownerLabel ?? '我'),
    type,
    text,
    ...(path ? { filePath: path } : {}),
  }
}

/**
 * Validate and normalize one get_messages result. Error messages deliberately
 * exclude plugin payloads because those may contain private chat text.
 */
export function normalizeWxvaultMessagesResponse(
  raw: WxvaultMessagesResponse,
  input: { contactId: string; from: string; to: string; ownerLabel?: string },
): CustomerMessage[] {
  if (stringValue(raw.error)) {
    throw new CustomerChatSourceError('WXVAULT_ERROR', 'wxvault could not read the selected conversation')
  }
  if (Array.isArray(raw.ambiguous) && raw.ambiguous.length > 0) {
    throw new CustomerChatSourceError('AMBIGUOUS_CONTACT', 'more than one wxvault conversation matched; use the exact contact id')
  }
  if (stringValue(raw.kind) !== '单聊') {
    throw new CustomerChatSourceError('UNSUPPORTED_CONVERSATION', 'customer review currently supports private conversations only')
  }
  const responseId = stringValue(raw.username)
  if (!responseId || responseId !== input.contactId || !Array.isArray(raw.messages)) {
    throw new CustomerChatSourceError('INVALID_RESPONSE', 'wxvault returned an invalid conversation response')
  }

  const from = normalizeBoundary(input.from, 'from')
  const to = normalizeBoundary(input.to, 'to')
  if (from > to) throw new CustomerChatSourceError('INVALID_TIME', 'customer review start time must not be after end time')

  return (raw.messages as WxvaultMessage[])
    .map(message => normalizeWxvaultMessage(message, {
      conversationId: responseId,
      ownerLabel: input.ownerLabel,
    }))
    .filter(message => message.time >= from && message.time <= to)
}

/**
 * Product-facing wxvault adapter. The caller owns the bridge lifecycle so a
 * daemon-level bridge can be shared instead of spawning one MCP child per API
 * request.
 */
export class WxvaultCustomerChatSource implements CustomerChatSource {
  constructor(
    private readonly bridge: WxvaultToolBridge,
    private readonly options: { ownerLabel?: string; contactLimit?: number; messageLimit?: number; hardCap?: number } = {},
  ) {}

  async searchContacts(query: string): Promise<CustomerContact[]> {
    const output = await this.call('list_conversations', {
      query: query.trim(),
      limit: this.options.contactLimit ?? 20,
    })
    const parsed = parsePluginJson(output)
    if (!Array.isArray(parsed)) {
      throw new CustomerChatSourceError('INVALID_RESPONSE', 'wxvault returned an invalid conversation list')
    }
    return (parsed as WxvaultConversation[])
      .map(normalizeWxvaultConversation)
      .filter((contact): contact is CustomerContact => contact !== null)
  }

  /**
   * Read every message in the range, paging through wxvault.
   *
   * WHY PAGING (this shipped as a single capped call): wxvault takes the
   * `after` branch and returns `order="ASC", limit=N` — the OLDEST N in the
   * range. With the cap at 2000, an active client's 3-month review silently
   * analyzed the first 2000 messages and reported `status: ready`. Commitments
   * made in the dropped tail never appeared, and commitments *completed* in
   * the tail were reported still-open — a confident, wrong list with no
   * warning anywhere. Nothing checked `messages.length === limit`.
   *
   * So: page forward on the last message's timestamp until wxvault returns a
   * short page. If the range is genuinely enormous we stop and say so (see
   * RANGE_TOO_LARGE) rather than quietly analyzing a prefix.
   */
  async getMessages(input: CustomerMessageQuery): Promise<CustomerMessage[]> {
    // `messageLimit` now bounds ONE page rather than the whole range — the
    // range itself is bounded by hardCap below.
    const maxPage = this.options.messageLimit ?? PAGE_SIZE
    const pageSize = Math.max(1, Math.min(input.limit ?? maxPage, maxPage))
    const hardCap = this.options.hardCap ?? HARD_MESSAGE_CAP
    const collected: CustomerMessage[] = []
    const seen = new Set<string>()
    let after = input.from

    for (;;) {
      const output = await this.call('get_messages', {
        // Always use the stable username selected from list_conversations;
        // never pass a mutable display name that may resolve ambiguously.
        conversation: input.contactId,
        limit: pageSize,
        after: wxvaultBoundary(after, 'from'),
        before: wxvaultBoundary(input.to, 'to'),
      })
      const parsed = parsePluginJson(output)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CustomerChatSourceError('INVALID_RESPONSE', 'wxvault returned an invalid conversation response')
      }
      const page = normalizeWxvaultMessagesResponse(parsed as WxvaultMessagesResponse, {
        contactId: input.contactId,
        from: after,
        to: input.to,
        ownerLabel: this.options.ownerLabel,
      })

      let added = 0
      for (const message of page) {
        // Pages overlap by one timestamp (`after` is inclusive on the plugin
        // side), and several messages can share a second — dedupe by identity.
        if (seen.has(message.evidenceKey)) continue
        seen.add(message.evidenceKey)
        collected.push(message)
        added += 1
      }

      if (collected.length > hardCap) {
        throw new CustomerChatSourceError(
          'RANGE_TOO_LARGE',
          `这段时间里的消息超过 ${hardCap} 条，请把时间范围缩小一些再回顾`,
        )
      }
      // A short page means the range is exhausted. `added === 0` also stops us
      // when every message in a page was a duplicate (all sharing one second),
      // which would otherwise loop forever on the same cursor.
      if (page.length < pageSize || added === 0) break

      const last = page[page.length - 1]
      if (!last || last.time <= after) break
      after = last.time
    }

    collected.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    return collected
  }

  private async call(tool: string, input: unknown): Promise<string> {
    try {
      return await this.bridge.call(tool, input)
    } catch (error) {
      if (error instanceof CustomerChatSourceError) throw error
      // Keep transport details out of the public error; child-process errors
      // can contain command paths or plugin output.
      throw new CustomerChatSourceError('WXVAULT_ERROR', `wxvault tool ${tool} is unavailable`)
    }
  }
}
