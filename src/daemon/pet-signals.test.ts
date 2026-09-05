import { describe, it, expect } from 'vitest'
import { makePetSignals, MAX_TRACKED_CHATS } from './pet-signals'

describe('makePetSignals', () => {
  it('按 chat 记 tool_call / 起飞 / 结束;contact 全局;snapshot 缺省 null', () => {
    let now = 1000
    const s = makePetSignals(() => now)
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, lastContactMs: null })
    s.noteTurnStart('c1'); now = 1500; s.noteToolCall('c1'); now = 2000; s.noteContact()
    expect(s.snapshot('c1')).toEqual({ inFlightSinceMs: 1000, lastToolCallAtMs: 1500, lastResultAtMs: null, lastContactMs: 2000 })
    now = 2500; s.noteTurnEnd('c1')
    expect(s.snapshot('c1')).toMatchObject({ inFlightSinceMs: null, lastResultAtMs: 2500 })
    expect(s.snapshot('c2')).toMatchObject({ lastToolCallAtMs: null, lastContactMs: 2000 })
  })

  it('显式 nowMs 参数优先于时钟', () => {
    const s = makePetSignals(() => 1)
    s.noteTurnEnd('c', 99); expect(s.snapshot('c').lastResultAtMs).toBe(99)
  })

  it('noteTurnStop 只撤起飞标记,不碰「刚忙完」(那一笔归 recordTurn)', () => {
    let now = 100
    const s = makePetSignals(() => now)
    now = 200; s.noteTurnEnd('c', 200)   // 上一回合的结局
    now = 300; s.noteTurnStart('c')
    expect(s.snapshot('c')).toMatchObject({ inFlightSinceMs: 300, lastResultAtMs: 200 })
    now = 400; s.noteTurnStop('c')
    expect(s.snapshot('c')).toMatchObject({ inFlightSinceMs: null, lastResultAtMs: 200 })
    // 没起飞过也能 stop(命令被路由截胡 / 重复 stop),不抛。
    expect(() => s.noteTurnStop('never-started')).not.toThrow()
  })

  it('每个 Map 有上界:超过 MAX_TRACKED_CHATS 就删掉最老的那个 chat', () => {
    const s = makePetSignals(() => 1)
    for (let i = 0; i < MAX_TRACKED_CHATS; i++) s.noteToolCall(`c${i}`)
    expect(s.snapshot('c0').lastToolCallAtMs).toBe(1)      // 还在
    s.noteToolCall('overflow')
    expect(s.snapshot('c0').lastToolCallAtMs).toBeNull()   // 最老的被挤掉
    expect(s.snapshot('c1').lastToolCallAtMs).toBe(1)
    expect(s.snapshot('overflow').lastToolCallAtMs).toBe(1)
    // 起飞 / 结束两张表同样有界。
    for (let i = 0; i <= MAX_TRACKED_CHATS; i++) { s.noteTurnStart(`s${i}`); s.noteTurnEnd(`e${i}`) }
    expect(s.snapshot('s0').inFlightSinceMs).toBeNull()
    expect(s.snapshot('e0').lastResultAtMs).toBeNull()
    expect(s.snapshot(`s${MAX_TRACKED_CHATS}`).inFlightSinceMs).toBe(1)
  })
})
