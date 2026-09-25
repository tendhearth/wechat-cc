import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryNightlyRuntime, deliverPendingNotice, type NoticeDeps } from './nightly-runtime'
import { readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, now: number, sent: string[]
let n = 0

function deps(over: Partial<NightlyRunDeps & NoticeDeps> = {}): NightlyRunDeps & NoticeDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => ['主人:周五前给 X 回话'], projectMemory: () => '' },
    cheapEval: () => async () => JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }], update: [], confirm: [], remove: [] }),
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => (0xa000 + n++).toString(16),
    log: () => {},
    careGate: () => ({ ok: true }),
    claim: vi.fn(),
    wechatSuspended: () => false,
    send: async (_c, t) => { sent.push(t); return {} },
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-rt-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '草稿\n')
  now = Date.parse('2026-09-25T04:05:00Z')
  sent = []
})

describe('memory nightly runtime', () => {
  it('tick at 04:05 writes the memory but holds the notice until 09:00', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.tick()
    expect(sent).toEqual([])
    now = Date.parse('2026-09-25T09:01:00Z')
    await rt.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('claims before sending, drops on care denial, waits on cooldown or a suspended WeChat link, expires after 24h', async () => {
    const claim = vi.fn()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'x', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    now = Date.parse('2026-09-25T10:00:00Z')
    expect(await deliverPendingNotice(deps({ wechatSuspended: () => true }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'memory_cooldown' }) }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ claim }))).toBe('sent')
    expect(claim).toHaveBeenCalledWith(OWNER, '2026-09-25T10:00:00.000Z')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'y', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'paused_no_reply' }) }))).toBe('dropped')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'z', createdAtMs: Date.parse('2026-09-24T04:00:00Z') } })
    expect(await deliverPendingNotice(deps())).toBe('expired')
    expect(sent).toEqual(['x'])
  })
  it('readCurated shows the rendered memory with a header; curatedView marks last night changes and dues', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    expect(rt.readCurated()).toBeNull()
    await rt.runNow()
    const text = rt.readCurated()!
    expect(text.split('\n')[0]).toBe('最近整理:2026-09-25 04:05 · 改了 1 处')
    expect(text).toContain('### 承诺\n- 周五前给 X 回话(期限 2026-09-26)')
    const v = rt.curatedView()!
    expect(v.updated_at).toBe('2026-09-25T04:05:00.000Z')
    expect(v.sections.find(s => s.name === '承诺')!.items[0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', due: '2026-09-26', changed: true })
  })
  it('warns in the header after three failed nights', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 3 })
    expect(rt.readCurated()!.split('\n')[0]).toBe('⚠️ 最近 3 次整理都没成功,下面可能是旧的。')
  })
})
