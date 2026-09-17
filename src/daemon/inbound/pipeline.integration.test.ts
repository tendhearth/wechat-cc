import { describe, it, expect, vi } from 'vitest'
import { buildInboundPipeline, type InboundPipelineDeps } from './build'
import type { InboundCtx } from './types'

function fakeDeps(over: Partial<{
  adminConsumes: boolean; modeConsumes: boolean; onboardingConsumes: boolean;
  permConsumes: boolean; guardEnabled: boolean; guardReachable: boolean;
}> = {}): { deps: InboundPipelineDeps; spy: { dispatch: ReturnType<typeof vi.fn>; activity: ReturnType<typeof vi.fn>; milestone: ReturnType<typeof vi.fn>; welcome: ReturnType<typeof vi.fn> } } {
  const dispatch = vi.fn(async () => {})
  const activity = vi.fn(async () => {})
  const milestone = vi.fn(async () => {})
  const welcome = vi.fn(async () => {})
  const log = () => {}
  const handled = new Set<string>()
  const deps: InboundPipelineDeps = {
    trace: { log },
    identity: { upsertIdentity: () => {} },
    dedup: {
      isHandled: id => handled.has(id),
      markHandled: id => { handled.add(id) },
      log,
    },
    access: {
      // Integration test default: allowlist contains the test chatId, so the
      // gate passes. Individual tests can override via the deps if needed.
      loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['c1'] }),
      log,
    },
    capture: { markChatActive: () => {}, captureContextToken: () => {} },
    typing: { sendTyping: async () => {} },
    admin: { adminHandler: { handle: async () => over.adminConsumes ?? false } },
    mode: { modeHandler: { handle: async () => over.modeConsumes ?? false } },
    onboarding: { onboardingHandler: { handle: async () => over.onboardingConsumes ?? false } },
    permissionReply: { handlePermissionReply: () => over.permConsumes ?? false, log },
    guard: {
      guardEnabled: () => over.guardEnabled ?? false,
      guardState: () => ({ reachable: over.guardReachable ?? true, ip: '1.2.3.4' }),
      sendMessage: async () => ({ msgId: 'm1' }),
      log,
    },
    attachments: { materializeAttachments: async () => {}, inboxDir: '/tmp', log },
    transcribeVoice: { log },
    messages: { append: async () => 1, log },
    activity: { recordInbound: activity, log },
    milestone: { fireMilestonesFor: milestone, log },
    welcome: { maybeWriteWelcomeObservation: welcome, log },
    recall: { isAdmin: () => false, log },
    llmHealth: {
      health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
      sendMessage: async () => ({ msgId: 'm1' }),
      now: () => 0,
      log,
    },
    dispatch: { coordinator: { dispatch } },
  }
  return { deps, spy: { dispatch, activity, milestone, welcome } }
}

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', text: 'hi' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r1',
})

describe('inbound pipeline (integration)', () => {
  it('consumes an accepted workbench file delivery without a duplicate text reply or companion dispatch',async()=>{
    const {deps,spy}=fakeDeps(),send=vi.fn(async()=>{})
    deps.workbench={handleWechat:async()=>({kind:'artifact_delivered',receiptId:'saved-delivery'}),sendMessage:send}
    const ctx=mkCtx();ctx.msg.text='任务 deadbeef 文件 12345678-1234-4234-8234-123456789012'
    await buildInboundPipeline(deps)(ctx)
    expect(ctx.consumedBy).toBe('workbench');expect(send).not.toHaveBeenCalled();expect(spy.dispatch).not.toHaveBeenCalled()
  })
  it('handles an authorized task before personal recall and unrelated companion LLM health',async()=>{
    const {deps,spy}=fakeDeps(),replies:string[]=[],recall=vi.fn(async()=>[])
    deps.workbench={handleWechat:async(_chat,text)=>text.startsWith('任务')?'任务结果':null,sendMessage:async(_chat,text)=>{replies.push(text)}}
    deps.recall={isAdmin:()=>true,recall,log:()=>{}}
    deps.llmHealth.health.shouldSuspend=()=>true
    const ctx=mkCtx();ctx.msg.text='任务 deadbeef'
    await buildInboundPipeline(deps)(ctx)
    expect(replies).toEqual(['任务结果']);expect(ctx.consumedBy).toBe('workbench')
    expect(recall).not.toHaveBeenCalled();expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('keeps access control ahead of phone task handling and leaves plain chat on its original path',async()=>{
    const {deps,spy}=fakeDeps(),handle=vi.fn(async()=>null),send=vi.fn(async()=>{})
    deps.workbench={handleWechat:handle,sendMessage:send}
    const denied=mkCtx();denied.msg.chatId='stranger';denied.msg.text='任务 deadbeef'
    await buildInboundPipeline(deps)(denied)
    expect(handle).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled()
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled()
  })

  it('does not route an allowlisted non-owner task command into ordinary conversation',async()=>{
    const {deps,spy}=fakeDeps(),send=vi.fn(async()=>{})
    deps.workbench={handleWechat:async()=>null,sendMessage:send}
    const ctx=mkCtx();ctx.msg.text='任务 deadbeef 允许 stale'
    await buildInboundPipeline(deps)(ctx)
    expect(ctx.consumedBy).toBe('workbench');expect(spy.dispatch).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('c1',expect.stringContaining('主人'))
  })

  it('does not drop distinct same-millisecond task commands and retries a transport error response',async()=>{
    const {deps,spy}=fakeDeps(),handled:string[]=[],replies:string[]=[],records:string[]=[]
    let fail=true
    deps.messages.append=async rec=>{records.push(rec.id);return 1}
    deps.workbench={handleWechat:async(_chat,text)=>{handled.push(text);return 'received'},sendMessage:async(_chat,text)=>{if(fail){fail=false;return{error:'send failed'}}replies.push(text);return{msgId:'sent'}}}
    const ctx=(text:string)=>({...mkCtx(),msg:{...mkCtx().msg,userId:'c1',createTimeMs:123,text}})
    const pipeline=buildInboundPipeline(deps)
    await pipeline(ctx('任务 deadbeef 补充 one'))
    await pipeline(ctx('任务 deadbeef 补充 one'))
    await pipeline(ctx('任务 deadbeef 补充 two'))
    await pipeline(ctx('任务 deadbeef 补充 two'))
    expect(handled).toEqual(['任务 deadbeef 补充 one','任务 deadbeef 补充 one','任务 deadbeef 补充 two'])
    expect(records[0]).toBe(records[1]);expect(records[1]).not.toBe(records[2]);expect(replies).toHaveLength(2)
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('full happy path: dispatch + W-tier all fire', async () => {
    const { deps, spy } = fakeDeps()
    const run = buildInboundPipeline(deps)
    await run(mkCtx())
    expect(spy.dispatch).toHaveBeenCalledOnce()
    // Allow fire-and-forget to settle
    await new Promise(r => setImmediate(r))
    expect(spy.activity).toHaveBeenCalledOnce()
    expect(spy.milestone).toHaveBeenCalledOnce()
    expect(spy.welcome).toHaveBeenCalledOnce()
  })

  it('redelivered message is deduped: agent dispatched only once across two deliveries', async () => {
    // The macOS sleep/wake bug: the long-poll cursor can redeliver an already-
    // answered message, and without processing-level dedup the agent re-runs
    // and re-replies. mw-dedup (wired right after access) must short-circuit.
    const { deps, spy } = fakeDeps()
    const run = buildInboundPipeline(deps)
    await run(mkCtx())
    await run(mkCtx()) // same message id (stable: no createTimeMs → content hash)
    expect(spy.dispatch).toHaveBeenCalledOnce()
  })

  it('admin short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ adminConsumes: true })
    const run = buildInboundPipeline(deps)
    const ctx = mkCtx()
    await run(ctx)
    expect(spy.dispatch).not.toHaveBeenCalled()
    expect(spy.activity).not.toHaveBeenCalled()
    expect(spy.milestone).not.toHaveBeenCalled()
    expect(spy.welcome).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('admin')
  })

  it('mode short-circuit: dispatch + W-tier all skipped', async () => {
    const { deps, spy } = fakeDeps({ modeConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('onboarding short-circuit', async () => {
    const { deps, spy } = fakeDeps({ onboardingConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('permission-reply short-circuit', async () => {
    const { deps, spy } = fakeDeps({ permConsumes: true })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('guard short-circuit when enabled and unreachable', async () => {
    const { deps, spy } = fakeDeps({ guardEnabled: true, guardReachable: false })
    await buildInboundPipeline(deps)(mkCtx())
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('guard runs BEFORE permission-reply: network-down drops a y/n reply', async () => {
    // Network is down AND the inbound looks like a permission reply. The
    // user-visible expectation is the guard's "🛑 出口 IP" notice, NOT a
    // silent forwarding of the approval to an in-flight Claude tool call
    // that probably needs network. Asserts the build.ts ordering.
    const { deps, spy } = fakeDeps({
      guardEnabled: true,
      guardReachable: false,
      permConsumes: true,
    })
    const ctx = mkCtx()
    await buildInboundPipeline(deps)(ctx)
    expect(ctx.consumedBy).toBe('guard')
    expect(spy.dispatch).not.toHaveBeenCalled()
  })

  it('dispatch error is caught by trace; pipeline does not reject', async () => {
    const { deps } = fakeDeps()
    deps.dispatch.coordinator.dispatch = async () => { throw new Error('coord-boom') }
    await expect(buildInboundPipeline(deps)(mkCtx())).resolves.toBeUndefined()
  })
})

describe('意图路由(第二步:消费者按 intent 早退)', () => {
  it('路由判成 mode 后,admin 的 handle 再想吃也轮不到;判成 chat 时所有消费者都不碰,直接进对话', async () => {
    const { deps, spy } = fakeDeps({ adminConsumes: true, modeConsumes: true })
    const adminHandle = vi.fn(async () => true)
    deps.admin = { adminHandler: { handle: adminHandle } }
    deps.route = { probes: { admin: () => false, mode: () => true, onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    const ctx = mkCtx(); ctx.msg.text = '/cc'
    await buildInboundPipeline(deps)(ctx)
    expect(ctx.intent?.kind).toBe('mode'); expect(ctx.consumedBy).toBe('mode'); expect(adminHandle).not.toHaveBeenCalled()
    deps.route = { probes: { admin: () => false, mode: () => false, onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    const chat = mkCtx(); chat.msg.text = 'hi'; chat.msg.msgId = 'm2' as never
    await buildInboundPipeline(deps)(chat)
    // 进了对话:没有消费者标记 consumedBy,coordinator.dispatch 被调(trace 行里显示为 consumed=dispatched)
    expect(chat.intent?.kind).toBe('chat'); expect(chat.consumedBy).toBeUndefined(); expect(adminHandle).not.toHaveBeenCalled(); expect(spy.dispatch).toHaveBeenCalledOnce()
  })
  it('开了路由却漏了某个在场消费者的探针 ⇒ 组装时就报错,不让它上线后永远轮不到', () => {
    const { deps } = fakeDeps()
    deps.route = { probes: { admin: () => false, mode: () => false, onboarding: () => false }, log: () => {} }
    expect(() => buildInboundPipeline(deps)).toThrow('probe missing for permission-reply')
    deps.cliReply = { handle: async () => false, log: () => {} }
    deps.route = { probes: { admin: () => false, mode: () => false, onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    expect(() => buildInboundPipeline(deps)).toThrow('probe missing for cli-reply')
    // 工作台和管家的探针由 build 自己接,不用外面给
    deps.cliReply = undefined
    deps.workbench = { handleWechat: async () => null, sendMessage: async () => ({}) }
    expect(() => buildInboundPipeline(deps)).not.toThrow()
  })
})

describe('意图路由(第三步:一站消费 + 语音先转文字再路由)', () => {
  it('语音消息:转出来的文字先到路由,再由对应的消费者吃掉(4b 曾让它永远判成 chat)', async () => {
    const { deps, spy } = fakeDeps()
    const modeHandle = vi.fn(async (msg: InboundCtx['msg']) => msg.text === '[语音] /帮助')
    deps.mode = { modeHandler: { handle: modeHandle } }
    deps.transcribeVoice = { transcribeVoice: async () => ({ text: '/帮助' }), readFile: async () => Buffer.from('amr'), log: () => {} }
    deps.route = { probes: { admin: () => false, mode: ctx => ctx.msg.text === '[语音] /帮助', onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    const ctx = mkCtx(); ctx.msg.text = '(non-text message)'; ctx.msg.attachments = [{ kind: 'voice', path: '/inbox/v.amr' } as never]
    await buildInboundPipeline(deps)(ctx)
    expect(ctx.msg.text).toBe('[语音] /帮助'); expect(ctx.intent?.kind).toBe('mode'); expect(ctx.consumedBy).toBe('mode'); expect(spy.dispatch).not.toHaveBeenCalled()
  })
  it('断网时:管理 / 模式命令照常执行(guard 在它们后面),权限回话与闲聊被 guard 拦下', async () => {
    const adminHandle = vi.fn(async () => true)
    const { deps: a } = fakeDeps({ guardEnabled: true, guardReachable: false })
    a.admin = { adminHandler: { handle: adminHandle } }
    a.route = { probes: { admin: () => true, mode: () => false, onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    const ctx = mkCtx(); ctx.msg.text = '/health'
    await buildInboundPipeline(a)(ctx)
    expect(ctx.consumedBy).toBe('admin'); expect(adminHandle).toHaveBeenCalledOnce()
    const perm = vi.fn(() => true)
    const { deps: b } = fakeDeps({ guardEnabled: true, guardReachable: false })
    b.permissionReply = { handlePermissionReply: perm, log: () => {} }
    b.route = { probes: { admin: () => false, mode: () => false, onboarding: () => false, 'permission-reply': () => true }, log: () => {} }
    const y = mkCtx(); y.msg.text = 'y'
    await buildInboundPipeline(b)(y)
    expect(y.consumedBy).toBe('guard'); expect(perm).not.toHaveBeenCalled()
  })
  it('任务命令不发"打字中",别的都发', async () => {
    const typing = vi.fn(async () => {})
    const { deps } = fakeDeps()
    deps.typing = { sendTyping: typing }
    deps.workbench = { handleWechat: async () => 'ok', sendMessage: async () => ({}) }
    deps.route = { probes: { admin: () => false, mode: () => false, onboarding: () => false, 'permission-reply': () => false }, log: () => {} }
    const cmd = mkCtx(); cmd.msg.text = '任务 列表'
    await buildInboundPipeline(deps)(cmd)
    expect(cmd.consumedBy).toBe('workbench'); expect(typing).not.toHaveBeenCalled()
    const chat = mkCtx(); chat.msg.text = 'hi'
    await buildInboundPipeline(deps)(chat)
    expect(typing).toHaveBeenCalledOnce()
  })
})
