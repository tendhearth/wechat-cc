import { describe, it, expect, vi } from 'vitest'
import { makeCliReplyHandler, makeCliReplyCore, makeHandReplyExecutor, readTail, defaultRunner, RESUME_TIMEOUT_MS, type Runner } from './reply-handler'
import type { CliSessionInfo } from '../../core/cli-events'
import { buildOverseerToday } from '../../domain/overseer-today'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sess = (over: Partial<CliSessionInfo> = {}): CliSessionInfo => ({
  session_id: 'a1b2c3-full', source: 'claude', cwd: '/w/p', transcript_path: '/t.jsonl', machine: 'here', lastSeenAt: 1, ...over,
})

function harness(opts: { sessions?: CliSessionInfo[]; run?: Runner; owner?: boolean; transcript?: string; pageUrl?: string | null } = {}) {
  const sent: string[] = []
  const sessions = opts.sessions ?? [sess()]
  const busy: string[] = []
  const h = makeCliReplyHandler({
    hub: { lookup: (p) => sessions.find(s => s.session_id.startsWith(p)) ?? null, sessions: () => sessions },
    isOwner: () => opts.owner ?? true,
    sendMessage: async (_c, t) => { sent.push(t) },
    sharePage: async () => opts.pageUrl === undefined ? 'https://x/docs/p' : opts.pageUrl,
    run: opts.run ?? (async () => ({ code: 0, stdout: '改好了', stderr: '', timedOut: false })),
    holdBusy: (l) => { busy.push(`+${l}`); return () => busy.push(`-${l}`) },
    log: () => {},
    dangerously: true,
    localMachine: 'here',
    readFile: () => opts.transcript ?? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '最后一句' }] } }),
  })
  return { h, sent, busy }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('reply-handler', () => {
  it('不是这两种句式 / 不是主人 → false,不回话', async () => {
    const a = harness()
    expect(await a.h.handle('随便聊聊', 'c')).toBe(false)
    const b = harness({ owner: false })
    expect(await b.h.handle('看 a1b2c3', 'c')).toBe(false)
    expect(b.sent).toEqual([])
  })

  it('终端:主人 → 回登记处列表(等你批准在前、带 y/n);不是主人 / 没接登记处 → 不认', async () => {
    const sent: string[] = []
    const base = {
      hub: { lookup: () => null, sessions: () => [] },
      sendMessage: async (_c: string, t: string) => { sent.push(t) },
      sharePage: async () => null,
      log: () => {},
      dangerously: false,
      localMachine: 'here',
    }
    const listSessions = vi.fn(() => [{
      session_id: 'ab12c3-x', code: 'ab12c3', source: 'claude' as const, status: 'waiting' as const, stale: false, project: 'wechat-cc', cwd: '/w/wechat-cc',
      machine: 'here', origin_agent: null, last_summary: null, last_event_at: 1_000, last_prompt_at: null, created_at: 1_000,
      pending: { tool: 'Bash', summary: 'ls', since: 1_000, hash: 'k3x9z', reply_code: null },
    }])
    const owner = makeCliReplyHandler({ ...base, isOwner: () => true, listSessions, now: () => 61_000 })
    expect(owner.probe('终端', 'c')).toBe(true)
    expect(await owner.handle('终端', 'c')).toBe(true)
    expect(sent[0]).toContain('等你批准 · wechat-cc · Claude · 码 ab12c3 · 1 分钟前')
    expect(sent[0]).toContain('回「y k3x9z」放行')

    const guest = makeCliReplyHandler({ ...base, isOwner: () => false, listSessions })
    expect(guest.probe('终端', 'c')).toBe(false)
    expect(await guest.handle('终端', 'c')).toBe(false)
    const unwired = makeCliReplyHandler({ ...base, isOwner: () => true })
    expect(unwired.probe('终端', 'c')).toBe(false)
    expect(await unwired.handle('终端', 'c')).toBe(false)
    expect(sent).toHaveLength(1)

    const broken = makeCliReplyHandler({ ...base, isOwner: () => true, listSessions: () => { throw new Error('db gone') } })
    expect(await broken.handle('终端', 'c')).toBe(true)
    expect(sent[1]).toContain('读不到终端会话')
  })

  it('日报:主人 → 回「今天」纯文本(不进模型);不是主人 / 没接 → 不认;读不到 → 说一声', async () => {
    const sent: string[] = []
    const base = {
      hub: { lookup: () => null, sessions: () => [] },
      sendMessage: async (_c: string, t: string) => { sent.push(t) },
      sharePage: async () => null,
      log: () => {},
      dangerously: false,
      localMachine: 'here',
    }
    const now = 1_800_000_000_000
    const today = vi.fn(() => buildOverseerToday({
      now, terminal: [], attention: [],
      tasks: [{ id: 'a1b2c3d4', title: '修打包', path: '/w/melu', providerId: 'codex', phase: 'replied', updatedAt: now - 60_000, error: null, archivedAt: null }],
    }))
    const owner = makeCliReplyHandler({ ...base, isOwner: () => true, today, now: () => now })
    expect(owner.probe('日报', 'c')).toBe(true)
    expect(await owner.handle('/today', 'c')).toBe(true)
    expect(sent[0]).toBe('今天(过去 24 小时):1 件做完\n做完 · 修打包 · 一起做 a1b2c3d4 · 1 分钟前\n「任务 编号」看一起做')

    const guest = makeCliReplyHandler({ ...base, isOwner: () => false, today })
    expect(guest.probe('日报', 'c')).toBe(false)
    expect(await guest.handle('日报', 'c')).toBe(false)
    const unwired = makeCliReplyHandler({ ...base, isOwner: () => true })
    expect(unwired.probe('日报', 'c')).toBe(false)
    expect(await unwired.handle('日报', 'c')).toBe(false)
    expect(await owner.handle('今天怎么样', 'c')).toBe(false)
    expect(sent).toHaveLength(1)

    const broken = makeCliReplyHandler({ ...base, isOwner: () => true, today: () => { throw new Error('db gone') } })
    expect(await broken.handle('日报', 'c')).toBe(true)
    expect(sent[1]).toBe('现在读不到今天的情况,稍后再试。')
  })

  it('看 码:渲染尾巴 → share_page → 回链接;没有页面就内联', async () => {
    const a = harness()
    expect(await a.h.handle('看 a1b2', 'c')).toBe(true)
    expect(a.sent[0]).toBe('Claude · 码 a1b2c3 最近的对话:https://x/docs/p')
    const b = harness({ pageUrl: null })
    await b.h.handle('看 a1b2c3', 'c')
    expect(b.sent[0]).toContain('最后一句')
  })

  it('码不认识 → 列最近的;那边的会话 → 说明暂不支持;没记录路径 → 说明', async () => {
    const a = harness({ sessions: [sess({ session_id: 'zzzzzz', source: 'codex' })] })
    await a.h.handle('看 a1b2c3', 'c')
    expect(a.sent[0]).toContain('没见过会话码「a1b2c3」')
    expect(a.sent[0]).toContain('zzzzzz(codex)')
    const b = harness({ sessions: [sess({ machine: 'win-test', origin_agent: 'win-test' })] })
    await b.h.handle('@a1b2c3 继续', 'c')
    expect(b.sent[0]).toContain('那边(win-test)')
    expect(b.sent[0]).toContain('接不上')
    const c = harness({ sessions: [sess({ transcript_path: undefined })] })
    await c.h.handle('看 a1b2c3', 'c')
    expect(c.sent[0]).toContain('没报过记录路径')
  })

  it('那边的会话:看 → remote.view 拿 markdown 做页面;说 → remote.say 转过去', async () => {
    const remoteView = vi.fn(async () => ({ ok: true as const, markdown: '# 那边\n\n**你**:x' }))
    const remoteSay = vi.fn(async () => ({ ok: true }))
    const sent: string[] = []
    const s = sess({ origin_agent: 'win-test', machine: 'WIN-PC' })
    const h = makeCliReplyHandler({
      hub: { lookup: () => s, sessions: () => [s] }, isOwner: () => true,
      sendMessage: async (_c, t) => { sent.push(t) }, sharePage: async () => 'https://x/docs/r',
      log: () => {}, dangerously: false, localMachine: 'here', remote: { view: remoteView, say: remoteSay },
    })
    await h.handle('看 a1b2c3', 'c')
    expect(remoteView).toHaveBeenCalledWith(s)
    expect(sent[0]).toBe('Claude · 码 a1b2c3 · 那边(WIN-PC) 最近的对话:https://x/docs/r')
    await h.handle('@a1b2c3 继续', 'c')
    expect(remoteSay).toHaveBeenCalledWith(s, '继续')
    expect(sent[1]).toContain('在那边接着跑')
  })

  it('@码 文本:先回「接着跑」,起 resume 进程(带 dangerously 旗),结果回来;busy 有始有终', async () => {
    const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = []
    const run: Runner = async (cmd, args, cwd, timeoutMs) => { calls.push({ cmd, args, cwd, timeoutMs }); return { code: 0, stdout: '**改好了**\n- 一', stderr: '', timedOut: false } }
    const a = harness({ run })
    expect(await a.h.handle('@a1b2c3 改成 X', 'c')).toBe(true)
    expect(a.sent[0]).toContain('接着跑')
    await tick(); await tick()
    expect(calls[0]).toEqual({ cmd: 'claude', args: ['-p', '--resume', 'a1b2c3-full', '--dangerously-skip-permissions', '--', '改成 X'], cwd: '/w/p', timeoutMs: RESUME_TIMEOUT_MS })
    expect(a.sent[1]).toBe('Claude · 码 a1b2c3 回来了\n改好了\n· 一')
    expect(a.busy).toEqual(['+cli-resume:a1b2c3', '-cli-resume:a1b2c3'])
  })

  it('@码:终端那边这一轮还没完(在跑 / 等批准 / stale)⇒ 不起 resume,说明一句(评审 10-15 #2)', async () => {
    const s = sess()
    for (const view of [{ status: 'running', stale: false }, { status: 'waiting', stale: false }, { status: 'idle', stale: true }]) {
      const sent: string[] = []
      const run = vi.fn<Runner>(async () => ({ code: 0, stdout: 'x', stderr: '', timedOut: false }))
      const h = makeCliReplyHandler({
        hub: { lookup: () => s, sessions: () => [s] }, isOwner: () => true,
        sendMessage: async (_c, t) => { sent.push(t) }, sharePage: async () => null, run,
        log: () => {}, dangerously: false, localMachine: 'here',
        listSessions: () => [{ session_id: s.session_id, ...view } as never],
      })
      expect(await h.handle('@a1b2c3 继续', 'c')).toBe(true)
      await tick()
      expect(sent[0]).toContain('这一轮还没完')
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('跑失败 / 超时 / 超长输出各有说法', async () => {
    const fail = harness({ run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }) })
    await fail.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(fail.sent[1]).toContain('没跑起来：boom')
    const slow = harness({ run: async () => ({ code: null, stdout: '一半', stderr: '', timedOut: true }) })
    await slow.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(slow.sent[1]).toContain('还没完,先停了')
    expect(slow.sent[1]).toContain('一半')
    const long = harness({ run: async () => ({ code: 0, stdout: 'x'.repeat(3000), stderr: '', timedOut: false }) })
    await long.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(long.sent[1]).toContain('全文:https://x/docs/p')
  })

  it('readTail 只读文件尾巴,丢掉被截断的第一行', () => {
    const d = mkdtempSync(join(tmpdir(), 'tail-'))
    try {
      const p = join(d, 't.jsonl')
      writeFileSync(p, 'line1\nline2\nline3\n')
      expect(readTail(p, 1000)).toBe('line1\nline2\nline3\n')
      expect(readTail(p, 9)).toBe('line3\n')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('defaultRunner(真起进程)', () => {
  it('收 stdout / exit code;到时限就掐掉并标 timedOut;命令不存在 → code null 带错误', async () => {
    // Windows runner 起一个 sh 偶尔就要 5s+(10-11 CI:5000ms 时限下 code null、stdout 空)。
    // 正常那条给足 30s;超时那条的时限也放到 3s,得等 sh 先吐出 start。
    const ok = await defaultRunner('sh', ['-c', 'echo hi; exit 3'], process.cwd(), 30_000)
    expect(ok).toMatchObject({ code: 3, stdout: 'hi\n', timedOut: false })
    const slow = await defaultRunner('sh', ['-c', 'echo start; sleep 10'], process.cwd(), 3000)
    expect(slow.timedOut).toBe(true)
    expect(slow.stdout).toContain('start')
    const missing = await defaultRunner('definitely-not-a-command-xyz', [], process.cwd(), 1000)
    expect(missing.code).toBeNull()
    expect(missing.stderr).toMatch(/ENOENT|not found/)
  }, 60_000)
})

describe('手侧 A2A 面(makeHandReplyExecutor)', () => {
  it('view → markdown;say → 起 resume,跑完 notifyBrain;不认识的会话 → session_unknown', async () => {
    const s = sess()
    const core = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s] }, run: async () => ({ code: 0, stdout: '那边改好了', stderr: '', timedOut: false }), log: () => {}, dangerously: false, readFile: () => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '尾巴' }] } }) })
    const brain: string[] = []
    const exec = makeHandReplyExecutor(core, { hub: { lookup: (p) => p === 'nope' ? null : s }, notifyBrain: async (t) => { brain.push(t) }, log: () => {} })
    const v = await exec({ kind: 'view', session_id: s.session_id })
    expect(v.ok).toBe(true); expect(v.markdown).toContain('尾巴')
    expect(await exec({ kind: 'say', session_id: s.session_id, text: '继续' })).toEqual({ ok: true })
    await tick(); await tick()
    expect(brain[0]).toBe('Claude · 码 a1b2c3 回来了\n那边改好了')
    expect(await exec({ kind: 'view', session_id: 'nope' })).toEqual({ ok: false, error: 'session_unknown' })
    expect(await exec({ kind: 'say', session_id: s.session_id })).toEqual({ ok: false, error: 'text_required' })
  })
})

it('refuses workbench-owned native replies and only releases a positively closed legacy writer',async()=>{
 const run=vi.fn(async()=>({code:0,stdout:'done',stderr:'',timedOut:false,closed:false})),settle=vi.fn(),reserveExecution=vi.fn(()=>settle)
 const deps={hub:{lookup:()=>sess(),sessions:()=>[sess()]},run,reserveExecution,log:()=>{},dangerously:false}
 expect((await makeCliReplyCore({...deps,executionConflict:()=>true}).resume(sess(),'go')).kind).toBe('failed');expect(run).not.toHaveBeenCalled();expect(reserveExecution).not.toHaveBeenCalled()
 await makeCliReplyCore(deps).resume(sess(),'go');expect(settle).toHaveBeenCalledWith(false)
 run.mockResolvedValueOnce({code:0,stdout:'done',stderr:'',timedOut:false,closed:true});await makeCliReplyCore(deps).resume(sess(),'go');expect(settle).toHaveBeenLastCalledWith(true)
})

it('network unprotected (2026-10-02) → resume never spawns the CLI; says why',async()=>{
 const run=vi.fn(async()=>({code:0,stdout:'done',stderr:'',timedOut:false,closed:true})),reserveExecution=vi.fn(()=>()=>{})
 const core=makeCliReplyCore({hub:{lookup:()=>sess(),sessions:()=>[sess()]},run,reserveExecution,log:()=>{},dangerously:false,networkGate:{check:async()=>({safe:false,source:'bx',detail:'bx 未保护'})}})
 const r=await core.resume(sess(),'go')
 expect(r.kind).toBe('failed');expect(r.text).toBe('网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。');expect(run).not.toHaveBeenCalled();expect(reserveExecution).not.toHaveBeenCalled()
})

it('守护 v2: a terminal Claude session behind a custom gateway (ANTHROPIC_BASE_URL) is not protected → resumes while unsafe',async()=>{
 const run=vi.fn(async()=>({code:0,stdout:'done',stderr:'',timedOut:false,closed:true})),check=vi.fn(async()=>({safe:false,source:'bx' as const,detail:'bx 未保护'}))
 const {classifyCall}=await import('../../lib/call-classifier')
 const core=makeCliReplyCore({hub:{lookup:()=>sess(),sessions:()=>[sess()]},run,reserveExecution:()=>()=>{},log:()=>{},dangerously:false,networkGate:{check,classify:t=>classifyCall({...t,baseUrl:'https://gw.example.com'})}})
 const r=await core.resume(sess(),'go')
 expect(r.kind).not.toBe('failed');expect(run).toHaveBeenCalled();expect(check).not.toHaveBeenCalled()
})

it('守护(2026-10-15):终端 Cursor 会话的模型登记处里没有 ⇒ 按需要保护;网络不安全不起 cursor-agent,安全就照常起',async()=>{
 const {classifyCall}=await import('../../lib/call-classifier')
 const run=vi.fn(async()=>({code:0,stdout:'done',stderr:'',timedOut:false,closed:true}))
 const unsafe=vi.fn(async()=>({safe:false,source:'bx' as const,detail:'bx 未保护'}))
 const cur=sess({source:'cursor'})
 const r=await makeCliReplyCore({hub:{lookup:()=>cur,sessions:()=>[cur]},run,reserveExecution:()=>()=>{},log:()=>{},dangerously:false,networkGate:{check:unsafe,classify:t=>classifyCall(t)}}).resume(cur,'go')
 expect(r.kind).toBe('failed');expect(r.text).toContain('Cursor');expect(run).not.toHaveBeenCalled()
 const safe=vi.fn(async()=>({safe:true,source:'bx' as const,detail:'ok'}))
 const ok=await makeCliReplyCore({hub:{lookup:()=>cur,sessions:()=>[cur]},run,reserveExecution:()=>()=>{},log:()=>{},dangerously:true,networkGate:{check:safe,classify:t=>classifyCall(t)}}).resume(cur,'go')
 expect(ok.kind).toBe('ok');expect(run).toHaveBeenCalledWith('cursor-agent',[`--resume=${cur.session_id}`,'-p','--trust','--force','--','go'],cur.cwd,expect.any(Number))
})

it('守护(2026-10-03):终端 Codex 会话按 codex 自己的配置判,不看 OPENAI_BASE_URL',async()=>{
 const {classifyCall}=await import('../../lib/call-classifier')
 const {mkdirSync}=await import('node:fs')
 const root=mkdtempSync(join(tmpdir(),'cli-reply-codex-')),home=join(root,'codex-home'),prior={home:process.env.CODEX_HOME,base:process.env.OPENAI_BASE_URL}
 mkdirSync(home,{recursive:true})
 process.env.CODEX_HOME=home;process.env.OPENAI_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
 try{
  const run=vi.fn(async()=>({code:0,stdout:'done',stderr:'',timedOut:false,closed:true})),check=vi.fn(async()=>({safe:false,source:'bx' as const,detail:'bx 未保护'}))
  const core=makeCliReplyCore({hub:{lookup:()=>sess(),sessions:()=>[sess()]},run,reserveExecution:()=>()=>{},log:()=>{},dangerously:false,networkGate:{check,classify:t=>classifyCall(t)}})
  const codex=sess({source:'codex',cwd:root})
  // config 默认(官方)⇒ 需要保护 ⇒ 不起 CLI —— 哪怕 OPENAI_BASE_URL 指到国内
  const r=await core.resume(codex,'go')
  expect(r.kind).toBe('failed');expect(r.text).toContain('Codex');expect(run).not.toHaveBeenCalled()
  // config 指到国内 ⇒ 不需要保护 ⇒ 照常起
  writeFileSync(join(home,'config.toml'),'model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com/v1"\n')
  expect((await core.resume(codex,'go')).kind).not.toBe('failed');expect(run).toHaveBeenCalled()
 }finally{
  if(prior.home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior.home
  if(prior.base===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=prior.base
  rmSync(root,{recursive:true,force:true})
 }
})

describe('makeCliReplyCore 把接着跑的这一轮记进登记处(手机看得到,2026-10-14)', () => {
  const s = { session_id: 'sess-1', source: 'claude' as const, cwd: '/w/p', lastSeenAt: 0, transcript_path: '/t.jsonl' }
  it('开跑记 prompt、跑完记 stop + 回复;失败 / 超时也记一句', async () => {
    const seen: { kind: string; text?: string; session_id: string; transcript_path?: string }[] = []
    const observe = (ev: { kind: string; text?: string; session_id: string }) => { seen.push(ev) }
    let release!: () => void
    const run: Runner = () => new Promise(r => { release = () => r({ code: 0, stdout: '改好了', stderr: '', timedOut: false }) })
    const core = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s], observe }, run, log: () => {}, dangerously: false })
    const p = core.resume(s, 'go')
    // 开跑那一刻(同步)就记了 running —— 手机据此拒绝再说一句。
    expect(seen).toEqual([expect.objectContaining({ kind: 'prompt', session_id: 'sess-1', transcript_path: '/t.jsonl' })])
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    release()
    expect((await p).kind).toBe('ok')
    expect(seen[1]).toMatchObject({ kind: 'stop', text: '改好了' })
    const failed = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s], observe }, run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }), log: () => {}, dangerously: false })
    await failed.resume(s, 'go')
    expect(seen.at(-1)!.text).toContain('没跑起来')
    const timeout = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s], observe }, run: async () => ({ code: null, stdout: '一半', stderr: '', timedOut: true }), log: () => {}, dangerously: false })
    await timeout.resume(s, 'go')
    expect(seen.at(-1)!.text).toContain('先停了')
  })
  it('observe 抛错不影响接着跑', async () => {
    const core = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s], observe: () => { throw new Error('db') } }, run: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }), log: () => {}, dangerously: false })
    expect((await core.resume(s, 'go')).kind).toBe('ok')
  })
})
