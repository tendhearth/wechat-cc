import { botTextMessage, ILINK_BASE_INFO, ilinkPost } from './ilink'

export type WorkbenchNoticeOutcome = {
  status: 'accepted' | 'deferred' | 'unknown' | 'blocked'
  reason?: string
}

export interface IlinkWorkbenchTextRequest {
  baseUrl: string
  token: string
  clientId: string
  ownerChatId: string
  text: string
  contextToken: string
  signal?: AbortSignal
  /** Narrow test seam; production uses ilinkPost's standard timeout. */
  timeoutMs?: number
}

function classify(raw: string): WorkbenchNoticeOutcome {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { status: 'unknown', reason: 'ambiguous_response' } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unknown', reason: 'ambiguous_response' }
  const response = value as Record<string, unknown>
  const present = ['errcode', 'ret'].filter(field => Object.hasOwn(response, field))
  if (present.length === 0 || present.some(field => typeof response[field] !== 'number')) {
    return { status: 'unknown', reason: 'ambiguous_response' }
  }
  const codes = present.map(field => response[field] as number)
  if (codes.every(code => code === 0)) return { status: 'accepted' }
  const distinctCodes = new Set(codes)
  if (distinctCodes.size !== 1) return { status: 'unknown', reason: 'ambiguous_response' }
  const code = codes[0]
  if (code === -2) return { status: 'deferred', reason: 'window_closed' }
  if (code === -14 || code === -6) return { status: 'blocked', reason: 'account_unavailable' }
  return { status: 'unknown', reason: 'server_rejected' }
}

/** Strict single-attempt text transport for persistent workbench notices. */
export async function sendIlinkWorkbenchText(request: IlinkWorkbenchTextRequest): Promise<WorkbenchNoticeOutcome> {
  const body = {
    msg: {
      from_user_id: '',
      client_id: request.clientId,
      ...botTextMessage(request.ownerChatId, request.text, request.contextToken),
    },
    base_info: ILINK_BASE_INFO,
  }
  try {
    const raw = await ilinkPost(
      request.baseUrl,
      'ilink/bot/sendmessage',
      body,
      request.token,
      request.timeoutMs,
      request.signal,
    )
    return classify(raw)
  } catch {
    return { status: 'unknown', reason: 'transport_uncertain' }
  }
}
