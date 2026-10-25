import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOwnerAsksStore, OWNER_ASKS_FILE } from '../../core/owner-asks-store'
import { combineReplyHandlers, makeAsksReply } from './asks-reply'

const T0 = Date.parse('2026-10-25T00:00:00.000Z')

function setup() {
  // 临时状态目录:绝不碰真机的 ~/.claude/channels/wechat
  const store = makeOwnerAsksStore(join(mkdtempSync(join(tmpdir(), 'asks-reply-')), OWNER_ASKS_FILE))
  store.enqueueVisibleCandidate({ key: 'k1', question: '微信里改成先问再做?', recommend: '改。', source: 'manual' })
  store.commitAsked(store.pickForBrief(1, new Date(T0).toISOString()), new Date(T0).toISOString())
  const said: string[] = []
  let now = T0 + 3600_000
  const h = makeAsksReply({ store, isOwner: c => c === 'owner', say: async (_c, t) => { said.push(t) }, now: () => now, log: () => {} })
  return { store, said, h, setNow: (t: number) => { now = t } }
}

describe('早报里拍板项的回话 × 记录文件正忙(整合者评审 #659)', () => {
  it('retries once; still failing ⇒ says it was not recorded and to reply again — never silently dropped', async () => {
    const { store, h, said } = setup()
    let fails = 1
    const real = store.answer.bind(store)
    store.answer = (a) => { if (fails-- > 0) throw new Error('ConcurrentJsonUpdateError'); return real(a) }
    expect(await h.handle('2', 'owner')).toBe(true)
    expect(said[0]).toBe('记下了,2 要:微信里改成先问再做?')
    const s2 = setup()
    s2.store.answer = () => { throw new Error('ConcurrentJsonUpdateError') }
    expect(await s2.h.handle('2 不要', 'owner')).toBe(true)
    expect(s2.said[0]).toBe('2 没记上(记录文件正忙),再回一次「2 不要」就行。')
    expect(s2.store.read().items[0]!.status).toBe('asked')
  })
})

describe('早报里拍板项的回话', () => {
  it('claims only the numbers the latest brief asked, only from the owner', () => {
    const { h } = setup()
    expect(h.probe('2', 'owner')).toBe(true)
    expect(h.probe('2 不要', 'owner')).toBe(true)
    expect(h.probe('1', 'owner')).toBe(false) // 早报自己的那条(y 码之类),不归这里
    expect(h.probe('2', 'stranger')).toBe(false)
    expect(h.probe('2 个人', 'owner')).toBe(false)
  })
  it('records the answer with who / when / which version, and says so without promising to do it now', async () => {
    const { h, said, store } = setup()
    expect(await h.handle('2', 'owner')).toBe(true)
    expect(said[0]).toBe('记下了,2 要:微信里改成先问再做?')
    const a = store.read().items[0]!
    expect(a.status).toBe('approved')
    expect(a.answer).toMatchObject({ verdict: 'approved', by: 'owner', via: 'wechat_brief', hash: a.hash })
    // 答过以后再回「2」:不归这里(普通聊天照旧),也不改答案
    expect(h.probe('2 不要', 'owner')).toBe(false)
    expect(await h.handle('2 不要', 'owner')).toBe(false)
    expect(said).toHaveLength(1)
    expect(store.read().items[0]!.status).toBe('approved')
  })
  it('after the reply window the number is plain chat again', () => {
    const { h, setNow } = setup()
    setNow(T0 + 13 * 3600_000)
    expect(h.probe('2', 'owner')).toBe(false)
  })
  it('combined with the jobs command: first claimer that handles wins', async () => {
    const { h } = setup()
    const order: string[] = []
    const jobs = { probe: (t: string) => t.startsWith('定时'), handle: async () => { order.push('jobs'); return true } }
    const c = combineReplyHandlers(jobs, h)
    expect(c.probe('定时', 'owner')).toBe(true)
    expect(c.probe('2', 'owner')).toBe(true)
    expect(c.probe('你好', 'owner')).toBe(false)
    expect(await c.handle('定时', 'owner')).toBe(true)
    expect(order).toEqual(['jobs'])
    expect(await c.handle('2 不要', 'owner')).toBe(true)
  })
})
