import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../lib/db'
import { makeCliEventHub, type CliEvent, type CliEventHub } from '../core/cli-events'
import { makeCliSessionStore } from '../core/cli-session-store'
import { makeCliReplyCore, type RunResult } from './cli-reply-handler'
import { makeTerminalSay, terminalSayMaxWaitMs, TERMINAL_SAY_HEADER, type TerminalSay, type TerminalSayDeps } from './cli-terminal-say'
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
let told: string[]
let transcript: string | null
let say: TerminalSay

const TP = '/w/cc/t.jsonl'
function make(over: Partial<TerminalSayDeps> = {}, coreOver: { dangerously?: boolean } = {}): TerminalSay {
  const core = makeCliReplyCore({
    hub, log: () => {}, dangerously: coreOver.dangerously ?? false,
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
  return makeTerminalSay({
    hub, core, log: () => {}, localMachine: 'mac', unclaimedGraceMs: 10,
    holdBusy: (l) => { busy.push(`+${l}`); return () => busy.push(`-${l}`) },
    notifyOwner: (t) => { told.push(t) },
    readTranscript: () => { if (transcript === null) throw new Error('ENOENT'); return transcript },
    ...over,
  })
}

beforeEach(() => {
  db = openDb({ path: ':memory:' })
  hub = makeCliEventHub({ send: async () => 'sent', projectName: (c) => c.split('/').pop()!, log: () => {}, store: makeCliSessionStore(db) })
  windows = new Map(); relayed = []; relayResult = { ok: true }; releaseRelay = null; runs = []; busy = []; told = []; transcript = null
  say = make()
})
afterEach(() => { say.dispose(); hub.dispose(); db.close() })

const ev = (over: Partial<CliEvent> & Pick<CliEvent, 'kind'>): CliEvent => ({ source: 'claude', session_id: 'abc123def', cwd: '/w/cc', machine: 'mac', transcript_path: TP, ...over })
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
const assistantLine = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

describe('送进开着的窗口', () => {
  it('第一行标明是 CC 代主人转来;连着的轮询等到下一个 Stop ⇒ 交给它(调用方不推);busy 持到拿到回话', async () => {
    hub.ingest(ev({ kind: 'stop', text: '上一轮做完了' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', '先停下,把 X 改成 Y')
    expect(r).toMatchObject({ ok: true, via: 'window', code: 'abc123', project: 'cc', was_running: false, read_only: false })
    if (!r.ok) throw new Error('unreachable')
    await tick()
    expect(relayed).toEqual([{ name: 'cc-dev', text: '先停下,把 X 改成 Y', header: TERMINAL_SAY_HEADER }])
    expect((await say.wait(r.ticket, 0))!.state).toBe('delivered')
    expect(busy).toEqual(['+terminal-say:abc123', '+cli-relay:abc123', '-cli-relay:abc123'])
    const waiting = say.wait(r.ticket, 5_000)
    // 别的会话的 Stop 不算
    expect(say.noteEvent(ev({ kind: 'stop', session_id: 'zzz999', text: '无关' }))).toBe(false)
    transcript = assistantLine('好的,已经停下,改成 Y 了。')
    expect(say.noteEvent(ev({ kind: 'stop', text: '好的,已经停下,改成 Y 了。' }))).toBe(true)
    const v = (await waiting)!
    expect(v).toMatchObject({ state: 'replied', final: true, delivered: true, via: 'window', reply: '好的,已经停下,改成 Y 了。', reply_verified: true })
    expect(busy.at(-1)).toBe('-terminal-say:abc123')
    await tick(30)
    expect(told).toEqual([])   // 领走了,不另告诉主人
  })

  it('回话里的密钥打码;和记录对不上 ⇒ reply_verified=false(照样带回)', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await tick()
    const waiting = say.wait(r.ticket, 5_000)
    transcript = assistantLine('别的话')
    say.noteEvent(ev({ kind: 'stop', text: 'token=sk-abcdefghijklmnopqrstuv' }))
    expect((await waiting)!).toMatchObject({ reply: 'token=[已打码]', reply_verified: false })
  })

  it('对方实际收到的那段话(窗口那条路的发信小进程提示词)', () => {
    const { args } = relayCommand('cc-dev', '先停下', false, 'claude', TERMINAL_SAY_HEADER)
    expect(args.at(-1)).toContain(`<relay>\n${TERMINAL_SAY_HEADER}\n先停下\n</relay>`)
    // 主人自己「@码」照旧
    expect(relayMessage('x')).toBe('主人从手机发来一句话(Tendhearth CC 转达,原话如下):\nx')
  })

  it('送到时它正在跑 ⇒ 送的那段时间里来的 Stop 当作上一轮的收尾丢掉(也没吞推送),等下一个;结果标 was_running', async () => {
    hub.ingest(ev({ kind: 'prompt' }))
    windows.set('abc123def', 'cc-dev')
    releaseRelay = () => {}
    const r = say.say('abc123', '做到哪了?')
    if (!r.ok) throw new Error(JSON.stringify(r))
    expect(r.was_running).toBe(true)
    await tick()
    const waiting = say.wait(r.ticket, 5_000)
    expect(say.noteEvent(ev({ kind: 'stop', text: '上一轮的收尾' }))).toBe(false)
    releaseRelay!()
    await tick()
    expect(say.view(r.ticket)!.state).toBe('delivered')
    say.noteEvent(ev({ kind: 'stop', text: '做到第 3 步了' }))
    expect((await waiting)!).toMatchObject({ state: 'replied', reply: '做到第 3 步了', was_running: true })
  })

  it('它本来歇着、答得比发信小进程退出还快 ⇒ 那个 Stop 就是回话', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'idle' }))
    windows.set('abc123def', 'cc-dev')
    releaseRelay = () => {}
    const r = say.say('abc123', 'ping')
    if (!r.ok) throw new Error('unreachable')
    await tick()
    say.noteEvent(ev({ kind: 'stop', text: 'pong' }))
    releaseRelay!()
    await tick()
    expect(say.view(r.ticket)).toMatchObject({ state: 'replied', reply: 'pong' })
  })

  it('没送进去 ⇒ failed、delivered=false;没人领 ⇒ 告诉主人没送到;busy 放掉', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    relayResult = { ok: false, error: '送进窗口超时' }
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await tick(30)
    expect(say.view(r.ticket)).toMatchObject({ state: 'failed', delivered: false, owner_notified: true })
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('码 abc123(CC 替你问的那句)没送到')
    expect(told[0]).toContain('送进窗口超时')
    expect(busy.filter(b => b.includes('terminal-say'))).toEqual(['+terminal-say:abc123', '-terminal-say:abc123'])
  })

  it('等不到 ⇒ 到点回 delivered;同一条会话下一句被挡;会话结束 ⇒ ended', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await tick()
    expect((await say.wait(r.ticket, 20))!).toMatchObject({ state: 'delivered', final: false, delivered: true, reply: null })
    expect(say.say('abc123', 'again')).toMatchObject({ ok: false, error: 'terminal_say_pending' })
    say.noteEvent(ev({ kind: 'session_end' }))
    expect(say.view(r.ticket)).toMatchObject({ state: 'ended', final: true })
  })
})

describe('什么时候吞「做完了」推送(评审 #662-2:只在连着的轮询会带回这份回话时)', () => {
  async function delivered() {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await tick()
    return r.ticket
  }
  it('只看一眼(wait 0)不算在等 ⇒ 照常推', async () => {
    const t = await delivered()
    await say.wait(t, 0)
    expect(say.noteEvent(ev({ kind: 'stop', text: '回了' }))).toBe(false)
  })
  it('上一次轮询到点回了 delivered、下一次还没来(空隙)⇒ 照常推;窗口那条路回话不另告诉主人(推送就是)', async () => {
    const t = await delivered()
    await say.wait(t, 10)
    expect(say.noteEvent(ev({ kind: 'stop', text: '回了' }))).toBe(false)
    await tick(30)
    expect(told).toEqual([])
  })
  it('请求断开(MCP 子进程死了)⇒ 那次等待立刻不算 ⇒ 照常推', async () => {
    const t = await delivered()
    const ac = new AbortController()
    const p = say.wait(t, 5_000, ac.signal)
    ac.abort()
    await p
    expect(say.noteEvent(ev({ kind: 'stop', text: '回了' }))).toBe(false)
  })
  it('空的 Stop 不算回话:接着等,不吞', async () => {
    const t = await delivered()
    const p = say.wait(t, 50)
    expect(say.noteEvent(ev({ kind: 'stop', text: '   ' }))).toBe(false)
    expect(say.noteEvent(ev({ kind: 'stop' }))).toBe(false)
    expect((await p)!.state).toBe('delivered')
  })
  it('身份对不上(别的记录路径 / 别的来源 / 别的机器)⇒ 不当回话、不吞', async () => {
    const t = await delivered()
    const p = say.wait(t, 50)
    expect(say.noteEvent(ev({ kind: 'stop', text: '伪造', transcript_path: '/tmp/forged.jsonl' }))).toBe(false)
    expect(say.noteEvent(ev({ kind: 'stop', text: '伪造', source: 'codex' }))).toBe(false)
    expect(say.noteEvent(ev({ kind: 'stop', text: '伪造', machine: 'other' }))).toBe(false)
    expect((await p)!.state).toBe('delivered')
  })
})

describe('窗口没开着 ⇒ 同「@码」:resume 接着原会话跑', () => {
  it('话前面一行是同一句标头;不带 daemon 的免审(只读续接);回话 = resume 的输出', async () => {
    say.dispose()
    say = make({}, { dangerously: true })
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    const r = say.say('abc123', '做到哪了?')
    expect(r).toMatchObject({ ok: true, via: 'resume', read_only: true })
    if (!r.ok) throw new Error('unreachable')
    await tick(); await tick()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.args).not.toContain('--dangerously-skip-permissions')
    expect(runs[0]!.args.slice(-2)).toEqual(['--', `${TERMINAL_SAY_HEADER}\n做到哪了?`])
    expect(say.view(r.ticket)).toMatchObject({ state: 'running', delivered: true })
    const waiting = say.wait(r.ticket, 5_000)
    runs[0]!.done({ code: 0, stdout: '做到第 3 步', stderr: '', timedOut: false })
    expect((await waiting)!).toMatchObject({ state: 'replied', reply: '做到第 3 步', read_only: true })
    await tick(30)
    expect(told).toEqual([])
  })

  it('主人自己「@码」的 resume 照旧带免审(只改 terminal_say 那一路)', async () => {
    const core = makeCliReplyCore({ hub, log: () => {}, dangerously: true, run: (_c, args) => new Promise(done => { runs.push({ args, done }) }) })
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    void core.resume(hub.lookup('abc123')!, 'hi')
    await tick(); await tick()
    expect(runs[0]!.args).toContain('--dangerously-skip-permissions')
    runs[0]!.done({ code: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('CC 那一轮早结束了(工具到点带票走了),resume 后来才跑完 ⇒ 没人领,daemon 自己告诉主人', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    const r = say.say('abc123', '做到哪了?')
    if (!r.ok) throw new Error('unreachable')
    await tick(); await tick()
    expect((await say.wait(r.ticket, 10))!.state).toBe('running')
    runs[0]!.done({ code: 0, stdout: '做到第 3 步', stderr: '', timedOut: false })
    await tick(40)
    expect(told).toEqual(['Claude · 码 abc123(CC 替你问的那句)回来了\n做到第 3 步'])
    expect(say.view(r.ticket)).toMatchObject({ owner_notified: true })
  })

  it('终局后几秒内工具来看了一眼 ⇒ 算领走,不另告诉主人', async () => {
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    const r = say.say('abc123', 'hi')
    if (!r.ok) throw new Error('unreachable')
    await tick(); await tick()
    runs[0]!.done({ code: 0, stdout: '好', stderr: '', timedOut: false })
    await tick()
    expect((await say.wait(r.ticket, 0))!.state).toBe('replied')
    await tick(40)
    expect(told).toEqual([])
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

describe('等多久:按 CC 这一轮的看门狗减余量', () => {
  it('缺省 10 分钟 ⇒ 570s;5 分钟 ⇒ 270s;关着(0)⇒ 上限 600s;返回给工具', () => {
    expect(terminalSayMaxWaitMs(600_000)).toBe(570_000)
    expect(terminalSayMaxWaitMs(300_000)).toBe(270_000)
    expect(terminalSayMaxWaitMs(0)).toBe(600_000)
    expect(terminalSayMaxWaitMs(3_600_000)).toBe(600_000)
    hub.ingest(ev({ kind: 'stop', text: 'x' }))
    windows.set('abc123def', 'cc-dev')
    const s5 = make({ turnTimeoutMs: 300_000 })
    expect(s5.say('abc123', 'hi')).toMatchObject({ ok: true, max_wait_ms: 270_000 })
    s5.dispose()
  })
})
