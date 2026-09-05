/**
 * pet-turn.ts — CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。纯函数:
 * 输入是 daemon 里真实存在的几个时间戳与旗标,输出是桌面直接消费的 payload。
 * 不看 presence(那是「处境」,另一条线);不发明任何东西。
 */
export const WORKING_WINDOW_MS = 5_000
/** lit → unlit 的退潮时间。owner 拍板 v1 不锁死,先当常量。 */
export const LIT_DIM_MS = 20 * 60_000

export type PetPhase = 'idle' | 'thinking' | 'working' | 'permission'

export interface PendingPermissionItem {
  hash: string
  prompt: string
  since: string
  expires_at: string
}

export interface PetTurnInputs {
  nowMs: number
  inFlight: boolean
  inFlightSinceMs: number | null
  lastToolCallAtMs: number | null
  lastResultAtMs: number | null
  ownerLastContactAtMs: number | null
  pending: PendingPermissionItem[]
}

export interface PetTurnPayload {
  owner_last_contact_at: string | null
  turn: { phase: PetPhase; since: string | null }
  last_done_at: string | null
  pending_permissions: PendingPermissionItem[]
}

const iso = (ms: number | null): string | null =>
  (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())

export function derivePetTurn(i: PetTurnInputs): PetTurnPayload {
  let turn: PetTurnPayload['turn'] = { phase: 'idle', since: null }
  if (i.pending.length > 0) {
    // 待决权限压过一切:桌宠在等主人拍板,别的都不重要。
    const earliest = [...i.pending].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))[0]!
    turn = { phase: 'permission', since: earliest.since }
  } else if (i.inFlight && i.lastToolCallAtMs !== null && i.nowMs - i.lastToolCallAtMs <= WORKING_WINDOW_MS) {
    turn = { phase: 'working', since: iso(i.lastToolCallAtMs) }
  } else if (i.inFlight) {
    turn = { phase: 'thinking', since: iso(i.inFlightSinceMs) }
  }
  return {
    owner_last_contact_at: iso(i.ownerLastContactAtMs),
    turn,
    last_done_at: iso(i.lastResultAtMs),
    pending_permissions: i.pending,
  }
}
