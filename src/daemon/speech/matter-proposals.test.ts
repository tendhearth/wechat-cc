import { describe, expect, it, vi } from 'vitest'
import type { PushPayload } from '../../features/phone/phone-push'
import { ESCALATE_AFTER_MS, makeMatterProposals } from './matter-proposals'
import type { SpeechOutcome } from './policy'

const OWNER = 'owner@im.wechat'
const T0 = Date.parse('2026-11-05T08:00:00.000Z')
const done: PushPayload = { kind: 'task_done', title: '做完了', body: '修登录', taskId: 't1' }
const perm: PushPayload = { kind: 'permission', title: '需要你批准', body: 'Bash: ls', taskId: 't1', requestId: 'p1' }

function setup(o: { desk?: boolean | 'throws'; app?: boolean; gate?: SpeechOutcome; owner?: string | null } = {}) {
  const gate = { push: vi.fn(), later: vi.fn() }
  const ask = vi.fn((): SpeechOutcome => o.gate ?? { allow: true, channel: 'desktop' })
  const notify = vi.fn(async () => true)
  const p = makeMatterProposals({
    gate, speech: { ask }, ownerChatId: () => (o.owner === undefined ? OWNER : o.owner),
    atDesk: async () => { if (o.desk === 'throws') throw new Error('ioreg'); return o.desk ?? false },
    desktop: { appConnected: () => o.app ?? false, notify },
    now: () => T0, log: () => {},
  })
  return { p, gate, ask, notify }
}

describe('一件事一次提议(S3b)', () => {
  it('批准 / 提问(blocking)⇒ 照旧原样交给推送,不判在场、不另问门', async () => {
    const s = setup({ desk: true })
    await s.p.propose(perm, 'ask:t1:p1')
    expect(s.gate.push).toHaveBeenCalledWith(perm, 'ask:t1:p1')
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.gate.later).not.toHaveBeenCalled()
  })
  it('做完了、人不在电脑前(或判不出)⇒ 照旧推 App', async () => {
    for (const desk of [false, 'throws'] as const) {
      const s = setup({ desk })
      await s.p.propose(done, 'turn:t1:2')
      expect(s.gate.push).toHaveBeenCalledWith(done, 'turn:t1:2')
      expect(s.gate.later).not.toHaveBeenCalled()
      expect(s.notify).not.toHaveBeenCalled()
    }
  })
  it('做完了、人在电脑前、桌面 app 没开 ⇒ 问门(带键、通道 desktop),daemon 弹桌面通知,App 那一条等 10 分钟', async () => {
    const s = setup({ desk: true })
    await s.p.propose(done, 'turn:t1:2')
    expect(s.ask).toHaveBeenCalledWith({ kind: 'matter_report', chatId: OWNER, ref: 'turn:t1:2' }, { channel: 'desktop', deliverable: true })
    expect(s.notify).toHaveBeenCalledWith('有一件事回复了', '打开 CC 查看。')   // 不放任务标题
    const f = setup({ desk: true }); await f.p.propose({ kind: 'task_failed', title: '没做成', body: '修登录', taskId: 't1' })
    expect(f.notify).toHaveBeenCalledWith('有一件事停下了', '打开 CC 看看发生了什么。')
    expect(s.gate.push).not.toHaveBeenCalled()
    expect(s.gate.later).toHaveBeenCalledWith(done, { at: T0 + ESCALATE_AFTER_MS, since: T0, matterId: 't1', ref: 'turn:t1:2' })
  })
  it('桌面 app 开着 ⇒ 它自己会弹,daemon 不另弹;App 那一条照样等', async () => {
    const s = setup({ desk: true, app: true })
    await s.p.propose(done, 'turn:t1:2')
    expect(s.notify).not.toHaveBeenCalled()
    expect(s.gate.later).toHaveBeenCalledOnce()
  })
  it('门说推后(免打扰)⇒ 交回推送那边照 S2 压着,不弹桌面', async () => {
    const s = setup({ desk: true, gate: { defer: true, reason: 'quiet_hours', until: '2026-11-05T23:00:00.000Z' } as SpeechOutcome })
    await s.p.propose(done, 'turn:t1:2')
    expect(s.gate.push).toHaveBeenCalledWith(done, 'turn:t1:2')
    expect(s.notify).not.toHaveBeenCalled()
    expect(s.gate.later).not.toHaveBeenCalled()
  })
  it('没有主人对话 ⇒ 没有可守的设置,照旧推', async () => {
    const s = setup({ desk: true, owner: null })
    await s.p.propose(done)
    expect(s.gate.push).toHaveBeenCalledWith(done, undefined)
  })
})
