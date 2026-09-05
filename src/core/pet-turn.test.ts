import { describe, it, expect } from 'vitest'
import { derivePetTurn, WORKING_WINDOW_MS, LIT_DIM_MS, type PetTurnInputs } from './pet-turn'

const T0 = Date.parse('2026-09-05T10:00:00.000Z')
const base: PetTurnInputs = {
  nowMs: T0,
  inFlight: false,
  inFlightSinceMs: null,
  lastToolCallAtMs: null,
  lastResultAtMs: null,
  ownerLastContactAtMs: null,
  pending: [],
}

describe('derivePetTurn', () => {
  it('常量', () => { expect(WORKING_WINDOW_MS).toBe(5_000); expect(LIT_DIM_MS).toBe(20 * 60_000) })

  it('空闲:全 null', () => {
    expect(derivePetTurn(base)).toEqual({
      owner_last_contact_at: null,
      turn: { phase: 'idle', since: null },
      last_done_at: null,
      pending_permissions: [],
    })
  })

  it('在飞没工具 → thinking(since = 起飞时间);5 秒内有 tool_call → working;过了 5 秒回 thinking', () => {
    const t = derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 3000 })
    expect(t.turn).toEqual({ phase: 'thinking', since: '2026-09-05T09:59:57.000Z' })
    expect(derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 3000, lastToolCallAtMs: T0 - 1000 }).turn)
      .toEqual({ phase: 'working', since: '2026-09-05T09:59:59.000Z' })
    expect(derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0 - 30000, lastToolCallAtMs: T0 - 6000 }).turn.phase)
      .toBe('thinking')
  })

  it('不在飞时旧的 tool_call 不算 working', () => {
    expect(derivePetTurn({ ...base, lastToolCallAtMs: T0 - 1000 }).turn.phase).toBe('idle')
  })

  it('有待决权限 → permission 压过一切,since = 最早那条', () => {
    const p = [
      { hash: 'b', prompt: 'x', since: '2026-09-05T09:59:50.000Z', expires_at: 'e' },
      { hash: 'a', prompt: 'y', since: '2026-09-05T09:59:40.000Z', expires_at: 'e' },
    ]
    const t = derivePetTurn({ ...base, inFlight: true, inFlightSinceMs: T0, lastToolCallAtMs: T0, pending: p })
    expect(t.turn).toEqual({ phase: 'permission', since: '2026-09-05T09:59:40.000Z' })
    expect(t.pending_permissions).toEqual(p)
  })

  it('last_done_at / owner_last_contact_at 是 ISO', () => {
    const t = derivePetTurn({ ...base, lastResultAtMs: T0 - 500, ownerLastContactAtMs: T0 - 60_000 })
    expect(t.last_done_at).toBe('2026-09-05T09:59:59.500Z')
    expect(t.owner_last_contact_at).toBe('2026-09-05T09:59:00.000Z')
  })
})
