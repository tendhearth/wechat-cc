import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../lib/db'
import { makeCliEventHub, type CliEvent, type CliEventHub } from '../core/cli-events'
import { makeCliSessionStore } from '../core/cli-session-store'
import { makeCliReplyCore, type RunResult } from './cli-reply-handler'
import { makeTerminalSay, TERMINAL_SAY_HEADER, type TerminalSay } from './cli-terminal-say'
import { relayCommand, relayMessage } from './claude-live-window'

/**
 * terminal_say(2026-10-24):真的 hub + 登记处 + 「@码」同一个 core,只把「起进程」和「送进窗口」换成假的。
 * 绝不碰真的终端窗口:liveWindow.relay 是假的,run 是假的。
 */
let db: Db
let hub: CliEventHub
let windows: Map<string, string>
let relayed: { name: string; text: string; header?: string }[]
let relayResult: { ok: true } | { ok: false; error: string }
let releaseRelay: (() => void) | null
let runs: { args: string[]; done: (r: RunResult) => void }[]
let busy: string[]
let say: TerminalSay

beforeEach(() => {
  db = openDb({ path: ':memory:' })
  hub = makeCliEventHub({ send: async () => 'sent', projectName: (c) => c.split('/').pop()!, log: () => {}, store: makeCliSessionStore(db) })
  windows = new Map(); relayed = []; relayResult = { ok: true }; releaseRelay = null; runs = []; busy = []
  const core = makeCliReplyCore({
    hub, log: () => {}, dangerously: false,
    holdBusy: (l) => { busy.push(`+${l}`); return () => busy.push(`-${l}`) },
    run: (_cmd, args) => new Promise(done => { runs.push({ args, done }) }),
    liveWindow: {
      find: (s) => windows.has(s.session_id) ? { pid: 1, name: windows.get(s.session_id)!, kind: 'interactive' } : null,
      relay: (w, text, header) => new Promise(res => {
        relayed.push({ name: w.name, text, ...(header !== undefined ? { header } : {}) })
        if (releaseRelay === null) res(relayResult)
        else releaseRelay = () => res(relayResult)
      }),
    },
  })
  say = makeTerminalSay({ hub, core, log: () => {}, localMachine: 'mac', holdBusy: (l) => { busy.push(`+${l}`); return () => busy.push(`-${l}`) } })
})
afterEach(() => { say.dispose(); hub.dispose(); db.close() })

const ev = (over: Partial<CliEvent> & Pick<CliEvent, 'kind'>): CliEvent => ({ source: 'claude', session_id: 'abc123def', cwd: '/w/cc', machine: 'mac', ...over })
const settle = () => new Promise(r => setTimeout(r, 0))

describe('送进开着的窗口', () => {
  it('第一行标明是 CC 代主人转来;等到这条会话的下一个 Stop,回话带回来;busy 持到拿到回话', async () => {
    hub.ingest(ev({ kind: 'stop', text: '上一轮做完了' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', '先停下,把 X 改成 Y')
    expect(r).toMatchObject({ ok: true, via: 'window', code: 'abc123', project: 'cc', was_running: false })
    if (!r.ok) throw new Error('unreachable')
    await settle()
    expect(relayed).toEqual([{ name: 'cc-dev', text: '先停下,把 X 改成 Y', header: TERMINAL_SAY_HEADER }])
    expect((await say.wait(r.ticket, 0))!.state).toBe('delivered')
    expect(busy).toEqual(['+terminal-say:abc123', '+cli-relay:abc123', '-cli-relay:abc123'])
    const waiting = say.wait(r.ticket, 5_000)
    // 别的会话的 Stop 不算
    expect(say.noteEvent(ev({ kind: 'stop', session_id: 'zzz999', text: '无关' }))).toBe(false)
    expect(say.noteEvent(ev({ kind: 'stop', text: '好的,已经停下,改成 Y 了。token=sk-abcdefghijklmnopqrstuv' }))).toBe(true)
    const v = (await waiting)!
    expect(v).toMatchObject({ state: 'replied', final: true, delivered: true, via: 'window' })
    expect(v.reply).toBe('好的,已经停下,改成 Y 了。token=[已打码]')
    expect(busy.at(-1)).toBe('-terminal-say:abc123')
  })

  it('对方实际收到的那段话(窗口那条路的发信小进程提示词)', () => {
    const { args } = relayCommand('cc-dev', '先停下', false, 'claude', TERMINAL_SAY_HEADER)
    expect(args.at(-1)).toContain(`<relay>\n${TERMINAL_SAY_HEADER}\n先停下\n</relay>`)
    // 主人自己「@码」照旧
    expect(relayMessage('x')).toBe('主人从手机发来一句话(Tendhearth CC 转达,原话如下):\nx')
  })

  it('送到时它正在跑 ⇒ 送的那段时间里来的 Stop 当作上一轮的收尾丢掉,等下一个;结果标 was_running', async () => {
    hub.ingest(ev({ kind: 'prompt' }))
    windows.set('abc123def', 'cc-dev')
    releaseRelay = () => {}
    const r = say.say('abc123', '做到哪了?')
    if (!r.ok) throw new Error(JSON.stringify(r))
    expect(r.was_running).toBe(true)
    await settle()
    say.noteEvent(ev({ kind: 'stop', text: '上一轮的收尾' }))
    releaseRelay!()
    await settle()
    expect(say.view(r.ticket)!.state).toBe('delivered')
    say.noteEvent(ev({ kind: 'stop', text: '做到第 3 步了' }))
    expect(say.view(r.ticket)).toMatchObject({ state: 'replied', reply: '做到第 3 步了', was_running: true })
  })

  it('它本来歇着、答得比发信小进程退出还快 ⇒ 那个 Stop 就是回话', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'idle' }))
    windows.set('abc123def', 'cc-dev')
    releaseRelay = () => {}
    const r = say.say('abc123', 'ping')
    if (!r.ok) throw new Error('unreachable')
    await settle()
    say.noteEvent(ev({ kind: 'stop', text: 'pong' }))
    releaseRelay!()
    await settle()
    expect(say.view(r.ticket)).toMatchObject({ state: 'replied', reply: 'pong' })
  })

  it('没送进去 ⇒ failed、delivered=false、带原因;busy 放掉', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    relayResult = { ok: false, error: '送进窗口超时' }
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    const v = (await say.wait(r.ticket, 1_000))!
    expect(v).toMatchObject({ state: 'failed', delivered: false })
    expect(v.error).toContain('送进窗口超时')
    expect(busy.filter(b => b.includes('terminal-say'))).toEqual(['+terminal-say:abc123', '-terminal-say:abc123'])
  })

  it('等不到 ⇒ 到点回 delivered(不是失败、也不说忙);同一条会话下一句被挡;会话结束 ⇒ ended', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await settle()
    expect((await say.wait(r.ticket, 20))!).toMatchObject({ state: 'delivered', final: false, delivered: true, reply: null })
    expect(say.say('abc123', 'again')).toMatchObject({ ok: false, error: 'terminal_say_pending' })
    say.noteEvent(ev({ kind: 'session_end' }))
    expect(say.view(r.ticket)).toMatchObject({ state: 'ended', final: true })
  })

  it('没人在等了(工具早超时)⇒ noteEvent 回 false,照常推「做完了」;回话照样记进票', async () => {
    let t = 1_000_000
    const late = makeTerminalSay({ hub, core: makeCliReplyCore({ hub, log: () => {}, dangerously: false, liveWindow: { find: () => ({ pid: 1, name: 'w', kind: 'interactive' }), relay: async () => ({ ok: true }) } }), log: () => {}, now: () => t })
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    const r = late.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await settle()
    t += 60_000
    expect(late.noteEvent(ev({ kind: 'stop', text: '晚到的回话' }))).toBe(false)
    expect(late.view(r.ticket)!.reply).toBe('晚到的回话')
    late.dispose()
  })
})

describe('窗口没开着 ⇒ 同「@码」:resume 接着原会话跑', () => {
  it('话前面一行是同一句标头;回话 = resume 的输出', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    const r = say.say('abc123', '做到哪了?')
    expect(r).toMatchObject({ ok: true, via: 'resume' })
    if (!r.ok) throw new Error('unreachable')
    await settle(); await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.args.slice(-2)).toEqual(['--', `${TERMINAL_SAY_HEADER}\n做到哪了?`])
    expect(say.view(r.ticket)).toMatchObject({ state: 'running', delivered: true })
    runs[0]!.done({ code: 0, stdout: '做到第 3 步', stderr: '', timedOut: false })
    expect((await say.wait(r.ticket, 1_000))!).toMatchObject({ state: 'replied', reply: '做到第 3 步' })
  })

  it('登记处说这一轮还没完 ⇒ 不起 resume,回原状态(running / waiting / stale),不说「忙」', () => {
    hub.ingest(ev({ kind: 'prompt' }))
    const r = say.say('abc123', 'hi')
    expect(r).toMatchObject({ ok: false, error: 'terminal_say_turn_open', status: 'running' })
    if (r.ok) throw new Error('unreachable')
    expect(r.detail).toContain('这一轮还在跑')
    expect(r.detail).not.toContain('忙')
    expect(runs).toHaveLength(0)
  })

  it('已结束(登记处按码找不到了,同「@码」)/ 没见过 / 别的机器 ⇒ 各自的码', () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    hub.ingest(ev({ kind: 'session_end' }))
    expect(say.say('abc123', 'hi')).toMatchObject({ ok: false, error: 'terminal_say_unknown_session' })
    expect(say.say('fff000', 'hi')).toMatchObject({ ok: false, error: 'terminal_say_unknown_session' })
    hub.ingest(ev({ kind: 'stop', session_id: 'bbb222ccc', machine: 'win-test', text: 'x' }))
    expect(say.say('bbb222', 'hi')).toMatchObject({ ok: false, error: 'terminal_say_remote' })
  })
})
