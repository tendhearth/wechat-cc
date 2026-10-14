import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIGEST_WINDOW_MS, MIN_TURN_MS, STOP_HOLD_MS, makeCliEventHub, type CliEvent, type CliPushItem } from '../core/cli-events'
import { makeCliPermissionRelay, type CliPermissionRelay } from '../core/cli-permission-relay'
import { buildCliPushPayload, cliPushTaskId, makeCliHubAppPush, makeCliPermissionAsk, type AppPushOutlet } from './cli-app-push'
import { makeCliPhoneActions } from './cli-phone-actions'
import { PendingPermissions } from './pending-permissions'
import type { PushPayload } from './phone-push'

/**
 * 终端会话推到手机 app(2026-10-14):与微信并列的第二个出口。推送与微信都是假的;
 * 中继、hub、手机拍板、待批登记处(PendingPermissions)是真的。
 */

const ev = (over: Partial<CliEvent> = {}): CliEvent => ({
  source: 'claude', kind: 'stop', session_id: 'a1b2c3d4-0000', cwd: '/w/wechat-cc', text: '**搞定了**', ...over,
})

function fakePush(result: { sent: number; online: number } | null = { sent: 1, online: 0 }) {
  const pushed: PushPayload[] = []
  const outlet: AppPushOutlet = (p) => { pushed.push(p); return result }
  return { pushed, outlet }
}

describe('buildCliPushPayload —— 一批一条,深链到会话', () => {
  const item = (o: Partial<CliPushItem> = {}): CliPushItem => ({ kind: 'stop', source: 'claude', session_id: 'S-1', projectName: 'proj', summary: '改完了', ...o })
  it('单条完成 ⇒ task_done,taskId = cli:<会话>', () => {
    expect(buildCliPushPayload([item()])).toEqual({ kind: 'task_done', title: 'claude 完成了', body: 'proj:改完了', taskId: 'cli:S-1' })
  })
  it('单条等批准 + 那边的机器 ⇒ permission,正文带机器名', () => {
    const p = buildCliPushPayload([item({ kind: 'permission', remoteMachine: 'win', summary: '' })])!
    expect(p.kind).toBe('permission')
    expect(p.body).toBe('proj(win) · claude 等你批准')
    expect(p.taskId).toBe('cli:S-1')
  })
  it('多条 ⇒ 一条汇总,taskId 只有前缀(app 去终端列表);有等批准的就是 permission', () => {
    const p = buildCliPushPayload([item(), item({ session_id: 'S-2', projectName: 'b', kind: 'permission', summary: 'Bash' })])!
    expect(p).toMatchObject({ kind: 'permission', taskId: 'cli:', body: 'proj:改完了 / b:Bash' })
    expect(buildCliPushPayload([])).toBeNull()
  })
  it('会话 id 不像样(太长 / 怪字符)⇒ 只给前缀,不把它塞进深链', () => {
    expect(cliPushTaskId('x'.repeat(57))).toBe('cli:')
    expect(cliPushTaskId('a/b')).toBe('cli:')
    expect(cliPushTaskId('019a-ff')).toBe('cli:019a-ff')
  })
})

describe('hub 的两个出口:微信 + 手机 app,同一套在场 / 快问快答 / 合并窗', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function harness(o: { sendResult?: 'sent' | 'rejected'; sendThrows?: boolean; idle?: number | null; push?: AppPushOutlet | null } = {}) {
    const sent: string[] = []
    const logs: string[] = []
    const fp = fakePush()
    const outlet = o.push === undefined ? fp.outlet : o.push
    const hub = makeCliEventHub({
      send: async (t) => { if (o.sendThrows) throw new Error('ilink down'); sent.push(t); return o.sendResult ?? 'sent' },
      pushApp: makeCliHubAppPush({ push: () => outlet, log: (a, b) => logs.push(`${a} ${b}`) }),
      projectName: (c) => c.split('/').pop()!,
      log: (a, b) => logs.push(`${a} ${b}`),
      ...(o.idle !== undefined ? { machineIdle: async () => o.idle ?? null } : {}),
    })
    return { hub, sent, pushed: fp.pushed, logs }
  }
  const settle = async () => { await vi.advanceTimersByTimeAsync(STOP_HOLD_MS); await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS) }

  it('主人走开 ⇒ 两个出口各一次;推送深链到这条会话', async () => {
    const { hub, sent, pushed } = harness({ idle: 600 })
    hub.ingest(ev())
    await settle()
    expect(sent).toHaveLength(1)
    expect(pushed).toEqual([{ kind: 'task_done', title: 'claude 完成了', body: 'wechat-cc:搞定了', taskId: 'cli:a1b2c3d4-0000' }])
  })

  it('微信拒了(errcode=-2)/ 抛了 ⇒ 手机照样收到', async () => {
    for (const o of [{ sendResult: 'rejected' as const }, { sendThrows: true }]) {
      const { hub, pushed, logs } = harness({ idle: 600, ...o })
      hub.ingest(ev())
      await settle()
      expect(pushed).toHaveLength(1)
      expect(logs.some(l => l.includes('wechat refused') || l.includes('send failed'))).toBe(true)
      hub.dispose()
    }
  })

  it('人在电脑前 ⇒ 都不推(只桌面);快问快答 ⇒ 都不推', async () => {
    const present = harness({ idle: 5 })
    present.hub.ingest(ev())
    await settle()
    expect(present.sent).toEqual([])
    expect(present.pushed).toEqual([])

    const quick = harness({ idle: 600 })
    quick.hub.ingest(ev({ kind: 'prompt', text: undefined }))
    await vi.advanceTimersByTimeAsync(MIN_TURN_MS - 1000)
    expect(quick.hub.ingest(ev())).toBe('noop')
    await settle()
    expect(quick.sent).toEqual([])
    expect(quick.pushed).toEqual([])
  })

  it('合并窗里两条会话 ⇒ 微信一条、手机一条', async () => {
    const { hub, sent, pushed } = harness({ idle: 600 })
    hub.ingest(ev())
    hub.ingest(ev({ session_id: 'b2', cwd: '/w/other', text: '另一件' }))
    await settle()
    expect(sent).toHaveLength(1)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.taskId).toBe('cli:')
  })

  it('推送出口抛了 / 没接(没开中继 v2)⇒ 微信不受影响,不重试', async () => {
    const boom = harness({ idle: 600, push: () => { throw new Error('relay gone') } })
    boom.hub.ingest(ev())
    await settle()
    expect(boom.sent).toHaveLength(1)
    expect(boom.logs.some(l => l.includes('app push failed'))).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(boom.sent).toHaveLength(1)

    const none = harness({ idle: 600, push: null })
    none.hub.ingest(ev())
    await settle()
    expect(none.sent).toHaveLength(1)
  })
})

describe('权限中继:先推手机,微信拒了码也不作废', () => {
  let pending: PendingPermissions
  let relay: CliPermissionRelay
  let wechat: 'ok' | 'refused'
  let owner: string | null
  let presence: 'present' | 'away'
  let cards: string[]
  let fp: ReturnType<typeof fakePush>
  let pushResult: { sent: number; online: number } | null
  let pushWired: boolean

  /** 同 ilink.askUser:先登记,再发卡;没送到 ⇒ 默认 fail(hash),keepOnUndelivered 则留着。 */
  const askUser = (chatId: string, prompt: string, hash: string, ms: number, o?: { keepOnUndelivered?: boolean }) => {
    const r = pending.register(hash, ms, { chatId, prompt })
    cards.push(prompt)
    void Promise.resolve().then(() => { if (wechat === 'refused' && !o?.keepOnUndelivered) pending.fail(hash) })
    return r
  }

  beforeEach(() => {
    pending = new PendingPermissions()
    wechat = 'ok'; owner = 'owner@im.wechat'; presence = 'away'; cards = []; pushResult = { sent: 1, online: 0 }; pushWired = true
    fp = { pushed: [], outlet: (p) => { fp.pushed.push(p); return pushResult } }
    relay = makeCliPermissionRelay({
      ask: makeCliPermissionAsk({
        ownerChatId: () => owner,
        askUser,
        registerPending: (h, ms, meta) => pending.register(h, ms, meta),
        sweepPending: () => pending.sweep(),
        push: () => (pushWired ? fp.outlet : null),
        localMachine: 'mac',
        log: () => {},
      }),
      presence: async () => presence,
      projectName: () => 'proj', onRelayed: () => {}, log: () => {},
    })
  })
  afterEach(() => { relay.dispose() })

  const open = () => relay.open({ source: 'claude', session_id: 'S1', cwd: '/w/proj', tool_name: 'Bash', summary: 'rm -rf ./tmp' })
  const tick = () => new Promise(r => setTimeout(r, 0))
  const phone = () => makeCliPhoneActions({
    hub: { lookup: () => null, list: () => [] }, relay, core: { resume: async () => {} } as never, log: () => {},
    resolve: (h, d) => pending.consume(h, d),
  })

  it('两个出口都走:微信卡 + 手机推送(深链这条会话,requestId 是码)', async () => {
    const r = await open()
    expect(r.status).toBe('pending')
    const hash = (r as { hash: string }).hash
    expect(cards).toHaveLength(1)
    expect(fp.pushed).toEqual([{ kind: 'permission', title: 'claude 等你批准', body: 'proj:Bash: rm -rf ./tmp', taskId: 'cli:S1', requestId: hash }])
    // 微信 y/n 照旧
    expect(pending.consume(hash, 'allow')).toBe(true)
    await tick()
    expect(relay.status(hash)).toBe('allow')
  })

  it('微信拒了 ⇒ 码仍是 pending,手机经 /m/api/cli/permission 拍板 ⇒ 中继拿到 allow', async () => {
    wechat = 'refused'
    const r = await open() as { hash: string }
    await tick(); await tick()
    expect(relay.status(r.hash)).toBe('pending')
    expect(fp.pushed).toHaveLength(1)
    expect(phone().permission({ session_id: 'S1' }, 'allow')).toEqual({ ok: true })
    await tick()
    expect(relay.status(r.hash)).toBe('allow')
  })

  it('手机正连着(在线跳过推送)也算够得着 ⇒ 码留着', async () => {
    wechat = 'refused'; pushResult = { sent: 0, online: 1 }
    const r = await open() as { hash: string }
    await tick(); await tick()
    expect(relay.status(r.hash)).toBe('pending')
  })

  it('手机够不着(没登记设备 / 没开中继 v2)+ 微信拒了 ⇒ undelivered,同改造前', async () => {
    wechat = 'refused'; pushResult = { sent: 0, online: 0 }
    const a = await open() as { hash: string }
    await tick(); await tick()
    expect(relay.status(a.hash)).toBe('undelivered')
    pushWired = false
    const b = await open() as { hash: string }
    await tick(); await tick()
    expect(relay.status(b.hash)).toBe('undelivered')
  })

  it('没有微信主人 chat:手机够得着 ⇒ 只登记,手机拍板;微信 chat 拍不了它', async () => {
    owner = null
    const r = await open() as { hash: string }
    expect(cards).toEqual([])
    expect(pending.approverOf(r.hash)).toBe('')
    expect(phone().permission({ hash: r.hash }, 'deny')).toEqual({ ok: true })
    await tick()
    expect(relay.status(r.hash)).toBe('deny')
    pushWired = false
    const b = await open() as { hash: string }
    await tick()
    expect(relay.status(b.hash)).toBe('undelivered')
  })

  it('主人在场 ⇒ 不推、不问(在场判断不变)', async () => {
    presence = 'present'
    expect(await open()).toEqual({ status: 'owner_present' })
    expect(fp.pushed).toEqual([])
    expect(cards).toEqual([])
  })

  it('推送抛了 ⇒ 照样问微信', async () => {
    pushWired = true
    fp.outlet = () => { throw new Error('relay gone') }
    const r = await open()
    expect(r.status).toBe('pending')
    expect(cards).toHaveLength(1)
  })
})
