import { describe, it, expect } from 'vitest'
import { makeMwTaskReference, type TaskReferenceMwDeps } from './mw-task-reference'
import type { TaskCandidate } from '../../core/workbench/task-reference'
import type { InboundCtx } from './types'

/**
 * 管家中间件:主人用自然语言说某件事,落定后翻译成已有的规范命令走 handleWechat
 * (复用它的去重、回执、回复格式),只加管家头、焦点和"问你选哪个"。落不定 ⇒ next(),
 * 不劫持普通聊天;非主人 ⇒ next()。
 */
const NOW = 1_800_000_000_000
const OWNER = 'owner@im.wechat'
const cand = (over: Partial<TaskCandidate> & { id: string }): TaskCandidate => ({ title: '', project: 'proj', path: '/p/proj', providerId: 'claude', phase: 'replied', updatedAt: NOW, ...over })
const todo = cand({ id: 'a85aec02', title: '读 NOTES.md,整理成 TODO.md', project: 'sample-project', path: '/s/sample-project' })
const latency = cand({ id: 'f3c7234a', title: '读 DATA.md,哪三个模型在 1 秒以内', project: 'project-b', path: '/s/project-b', providerId: 'codex' })
const review = cand({ id: '5c12e75a', title: '检查 · 读 DATA.md,哪三个模型在 1 秒以内', project: 'project-b', path: '/s/project-b' })

function setup(over: Partial<TaskReferenceMwDeps> = {}) {
  const commands: string[] = [], sent: string[] = [], watches: string[] = []
  let t = NOW
  const deps: TaskReferenceMwDeps = {
    ownerChatId: () => OWNER,
    candidates: () => [todo, latency, review],
    // 「提醒我」是管家第一次点名时顺手开的,单独记,不混进主要动作的断言。
    handleWechat: async (_chat, text) => { (/ 提醒我$/.test(text) ? watches : commands).push(text); return `任务 ${/[a-f0-9]{8}/.exec(text)?.[0]}：好的。` },
    sendMessage: async (_chat, text) => { sent.push(text); return {} },
    now: () => t,
    log: () => {},
    ...over,
  }
  const mw = makeMwTaskReference(deps)
  const run = async (text: string, extra: { chatId?: string; quote?: string } = {}) => {
    const ctx = { msg: { chatId: extra.chatId ?? OWNER, userId: 'u', text, msgType: 'text', createTimeMs: t, accountId: 'acct', ...(extra.quote ? { quote: { type: 'text', text: extra.quote } } : {}) }, receivedAtMs: t, requestId: 'r' } as any
    let nexted = false
    await mw(ctx, async () => { nexted = true })
    return { nexted, consumed: ctx.consumedBy }
  }
  return { run, commands, sent, watches, advance: (ms: number) => { t += ms } }
}

describe('mw-task-reference', () => {
  it('非主人 ⇒ 直接放行', async () => {
    const { run, commands } = setup()
    expect((await run('整理 TODO 那件继续', { chatId: 'guest@im.wechat' })).nexted).toBe(true)
    expect(commands).toEqual([])
  })

  it('普通聊天落不定 ⇒ 放行,不劫持', async () => {
    const { run, commands, sent } = setup()
    expect((await run('今天天气不错')).nexted).toBe(true)
    expect(commands).toEqual([]); expect(sent).toEqual([])
  })

  it('落定 + 自由文本 ⇒ 翻译成「任务 <id> 补充 <原话>」,回复带管家头', async () => {
    const { run, commands, sent } = setup()
    const r = await run('整理 TODO 那件,把下周那条也放进去')
    expect(r.nexted).toBe(false); expect(r.consumed).toBe('workbench')
    expect(commands).toEqual(['任务 a85aec02 补充 整理 TODO 那件,把下周那条也放进去'])
    expect(sent[0]).toMatch(/^📁 sample-project · 读 NOTES\.md,整理成 TODO\.md · Claude/)
    expect(sent[0]).toContain('任务 a85aec02：好的。')
  })

  it('"停止/结束"动词 ⇒ 「任务 <id> 停止」;"结果/进展/怎么样" ⇒ 「任务 <id>」', async () => {
    const { run, commands } = setup()
    await run('整理 TODO 那件停止')
    await run('sample-project 那个怎么样了')
    expect(commands).toEqual(['任务 a85aec02 停止', '任务 a85aec02'])
  })

  it('引用 CC 的任务消息回话 ⇒ 归属跟着引用走', async () => {
    const { run, commands } = setup()
    await run('把 1 秒以内的单独列出来', { quote: '任务 f3c7234a：已答复 —— 四个模型…' })
    expect(commands).toEqual(['任务 f3c7234a 补充 把 1 秒以内的单独列出来'])
  })

  it('多件命中 ⇒ 问一句并列出选项;回数字 ⇒ 用原话对选中的那件执行', async () => {
    const { run, commands, sent } = setup()
    const first = await run('project-b 那个继续')
    expect(first.consumed).toBe('workbench'); expect(commands).toEqual([])
    expect(sent[0]).toMatch(/你说的是哪一件/); expect(sent[0]).toMatch(/1\..*project-b/); expect(sent[0]).toMatch(/2\..*project-b/)
    await run('2')
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatch(/^任务 (f3c7234a|5c12e75a) 补充 project-b 那个继续$/)
  })

  it('"接下来说 X" ⇒ 设焦点并回显;之后的裸消息默认归它;20 分钟后失效', async () => {
    const { run, commands, sent, advance } = setup()
    const r = await run('接下来说整理 TODO 那件')
    expect(r.consumed).toBe('workbench'); expect(commands).toEqual([])
    expect(sent[0]).toMatch(/接下来默认说.*sample-project.*20 分钟/)
    await run('再补一句:标题用中文')
    expect(commands).toEqual(['任务 a85aec02 补充 再补一句:标题用中文'])
    advance(21 * 60_000)
    expect((await run('再补一句:标题用中文')).nexted).toBe(true)
    expect(commands).toHaveLength(1)
  })

  it('落定后的动作也会把焦点放到这件上(回显一次)', async () => {
    const { run, sent, commands } = setup()
    await run('整理 TODO 那件继续')
    expect(sent[0]).toMatch(/接下来默认说这件/)
    await run('顺便把注释也删了')
    expect(commands[1]).toBe('任务 a85aec02 补充 顺便把注释也删了')
    expect(sent[1]).not.toMatch(/接下来默认说这件/)
  })

  it('handleWechat 拒绝(非主人/失效)时把它的话原样转达', async () => {
    const { run, sent } = setup({ handleWechat: async () => null })
    await run('整理 TODO 那件继续')
    expect(sent[0]).toMatch(/任务控制仅对已绑定的主人开放/)
  })
})

describe('真机回归 2026-09-16', () => {
  it('从没问过"哪一件"时回一个裸数字 ⇒ 放行(可能是在回陪伴),绝不变成某个任务的补充', async () => {
    const { run, commands } = setup()
    await run('整理 TODO 那件继续') // 设了焦点
    const r = await run('2')
    expect(r.nexted).toBe(true)
    expect(commands.filter(c => c.includes('补充 2'))).toEqual([])
  })
  it('待选窗口 30 分钟:8 分钟后回数字仍算选择', async () => {
    const { run, commands, advance } = setup()
    await run('project-b 那个继续')
    advance(8 * 60_000)
    await run('2')
    expect(commands).toHaveLength(1); expect(commands[0]).toMatch(/^任务 (f3c7234a|5c12e75a) 补充 project-b 那个继续$/)
  })
  it('主人从微信第一次点名某件事 ⇒ 顺手为它开提醒(每件一次,直调 watchTask),失败/完成才到得了手机', async () => {
    const watched: string[] = []
    const { run, commands } = setup({ watchTask: async (id) => { watched.push(id) } })
    await run('整理 TODO 那件继续')
    await run('顺便把注释也删了')
    expect(watched).toEqual(['a85aec02'])
    expect(commands).toEqual(['任务 a85aec02 补充 整理 TODO 那件继续', '任务 a85aec02 补充 顺便把注释也删了'])
  })
})

describe('额度止损:执行者额度用完时,不再往它送,直接问"交给另一位继续?"', () => {
  const T = NOW
  const quotaOn = (over: Partial<TaskReferenceMwDeps> = {}) => {
    const created: Array<{ path: string; providerId: string; text: string }> = []
    const s = setup({
      quotaExhausted: (id) => id === 'codex' ? { kind: 'quota', since: T - 60_000, resetAt: T + 25 * 60_000, message: "You've hit your usage limit" } : null,
      fallbackExecutor: (id) => id === 'codex' ? 'claude' : 'codex',
      createTask: async (input) => { created.push(input); return { id: 'c0ffee00' } },
      ...over,
    })
    return { ...s, created }
  }
  it('落定到额度耗尽的 Codex 任务 ⇒ 不发补充,回"额度用完…交给 Claude 继续?回「是」"', async () => {
    const { run, commands, sent } = quotaOn()
    const r = await run('project-b 那个 codex 做的,再加一列百分比')
    expect(r.consumed).toBe('workbench'); expect(commands).toEqual([])
    expect(sent.at(-1)).toMatch(/Codex 的额度已用完/); expect(sent.at(-1)).toMatch(/约 2[0-9] 分钟/); expect(sent.at(-1)).toMatch(/交给 Claude 继续.*回「是」/)
  })
  it('回「是」⇒ 在同一文件夹给 Claude 新开一件,带上原标题和刚才的要求,回复新任务的管家头', async () => {
    const { run, sent, created } = quotaOn()
    await run('project-b 那个 codex 做的,再加一列百分比')
    await run('是')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ path: '/s/project-b', providerId: 'claude' })
    expect(created[0]!.text).toContain('读 DATA.md,哪三个模型在 1 秒以内'); expect(created[0]!.text).toContain('再加一列百分比'); expect(created[0]!.text).toMatch(/接替 Codex/)
    expect(sent.at(-1)).toMatch(/已交给 Claude/); expect(sent.at(-1)).toMatch(/c0ffee00/)
  })
  it('回「不用」⇒ 作罢;之后的「是」不再算接管', async () => {
    const { run, created, sent } = quotaOn()
    await run('project-b 那个 codex 做的,再加一列百分比')
    await run('不用')
    expect(sent.at(-1)).toMatch(/好/)
    const r = await run('是')
    expect(created).toEqual([]); expect(r.nexted).toBe(true)
  })
  it('没有可接的执行者(两家都没额度)⇒ 说清楚,不新开', async () => {
    const { run, sent, created } = quotaOn({ fallbackExecutor: () => null })
    await run('project-b 那个 codex 做的,再加一列百分比')
    expect(sent.at(-1)).toMatch(/没有可以接手的执行者/); expect(created).toEqual([])
  })
  it('通知里说过"回「是」":没有待确认接管、但只有一件近期因额度失败的任务 ⇒ 「是」就是它', async () => {
    const failed = { ...latency, phase: 'failed', updatedAt: T - 60_000, error: 'provider_quota_exhausted' } as TaskCandidate
    const { run, created } = quotaOn({ candidates: () => [todo, failed] })
    await run('是')
    expect(created).toHaveLength(1); expect(created[0]!.providerId).toBe('claude')
  })
})

describe('评审回归(2026-09-16 独立评审)', () => {
  it('#1 开提醒走 watchTask 直调,真正的命令仍是 handleWechat 收到的唯一一条 —— 不能撞回执', async () => {
    const watched: string[] = []
    const { run, commands } = setup({ watchTask: async (id) => { watched.push(id) } })
    await run('整理 TODO 那件继续')
    expect(commands).toEqual(['任务 a85aec02 补充 整理 TODO 那件继续'])
    expect(watched).toEqual(['a85aec02'])
  })
  it('#6 没有待选问题时的裸数字 ⇒ 放行给陪伴(它可能刚问过"几点提醒你")', async () => {
    const { run, commands } = setup()
    const r = await run('8')
    expect(r.nexted).toBe(true); expect(commands).toEqual([])
  })
  it('#7 动词只认短句:补充里提到"文件/看看"不改写成只读命令', async () => {
    const { run, commands } = setup()
    await run('整理 TODO 那件,把文件名改成中文')
    await run('sample-project 那个结果')
    expect(commands).toEqual(['任务 a85aec02 补充 整理 TODO 那件,把文件名改成中文', '任务 a85aec02 结果'])
  })
  it('#3 「是/不用」只认整句;待接管时"好像还没开始做"不是同意', async () => {
    const created: unknown[] = []
    const { run } = setup({ quotaExhausted: (id) => id === 'codex' ? { kind: 'quota', since: NOW, resetAt: NOW + 60_000, message: 'limit' } : null, fallbackExecutor: () => 'claude', createTask: async (i) => { created.push(i); return { id: 'c0ffee00' } } })
    await run('project-b 那个 codex 做的,再加一列百分比')
    await run('好像还没开始做，等等再说')
    expect(created).toEqual([])
  })
  it('#3 没有待接管时,"嗯嗯"/"行吗"不会凭最近一件额度失败的任务开新任务', async () => {
    const created: unknown[] = []
    const failed = { ...latency, phase: 'failed', updatedAt: NOW - 60_000, error: 'provider_quota_exhausted' } as TaskCandidate
    const { run } = setup({ candidates: () => [todo, failed], fallbackExecutor: () => 'claude', createTask: async (i) => { created.push(i); return { id: 'c0ffee00' } } })
    for (const t of ['嗯嗯', '行吗', '好久不见']) expect((await run(t)).nexted, t).toBe(true)
    expect(created).toEqual([])
  })
  it('#4 接管落账:再说「是」不重开,焦点已移到新任务,下一句自由文本补充给新任务', async () => {
    const created: Array<{ providerId: string }> = []
    const { run, commands, sent } = setup({ quotaExhausted: (id) => id === 'codex' ? { kind: 'quota', since: NOW, resetAt: NOW + 60_000, message: 'limit' } : null, fallbackExecutor: () => 'claude', createTask: async (i) => { created.push(i); return { id: 'c0ffee00' } } })
    await run('project-b 那个 codex 做的,再加一列百分比')
    await run('是')
    await run('是')
    expect(created).toHaveLength(1)
    expect(sent.at(-1)).toMatch(/已经交给 Claude|c0ffee00/)
    await run('再加一列百分比')
    expect(commands.at(-1)).toBe('任务 c0ffee00 补充 再加一列百分比')
  })
})

describe('只读探针(意图路由第一步,2026-09-17)', () => {
  const judgeCalls: string[] = []
  const judge = async ({ text }: { text: string }) => { judgeCalls.push(text); return { taskId: null, confident: false } }
  const probeSetup = () => {
    const s = setup({ judge })
    const mw = makeMwTaskReference({ ownerChatId: () => OWNER, candidates: () => [todo, latency, review], handleWechat: async () => '好的。', sendMessage: async () => ({}), now: () => NOW, log: () => {}, judge })
    const ctx = (text: string, chatId = OWNER): InboundCtx => ({ msg: { chatId, userId: 'u', text, msgType: 'text', createTimeMs: NOW, accountId: 'acct' }, receivedAtMs: NOW, requestId: 'r' })
    return { ...s, mw, ctx }
  }
  it('探针的"是 / 不是"和中间件是否放行一一对应(同一份 fixture)', async () => {
    const cases: Array<[string, string]> = [['todo 那件进展怎么样', OWNER], ['今天天气不错', OWNER], ['3', OWNER], ['是', OWNER], ['任务 列表', OWNER], ['todo 那件进展怎么样', 'stranger@im.wechat']]
    for (const [text, chatId] of cases) {
      const { mw, ctx, run } = probeSetup()
      const probed = await mw.probe(ctx(text, chatId))
      const { nexted } = await run(text, { chatId })
      expect(!!probed, `${chatId}: ${text}`).toBe(!nexted)
    }
  })
  it('探针不改状态:问两遍结果一样,之后中间件照常执行;多件命中时探针也不发"哪一件"', async () => {
    const { mw, ctx, sent } = probeSetup()
    const a = await mw.probe(ctx('DATA.md 那件怎么样了')), b = await mw.probe(ctx('DATA.md 那件怎么样了'))
    expect(a?.kind).toBe('task-reference'); expect((a?.data as { kind: string }).kind).toBe('ambiguous'); expect(b).toEqual(a)
    expect(sent).toEqual([])
  })
  it('路由阶段算过的判定随 intent.data 带进来 ⇒ 中间件直接用,便宜模型不问第二遍', async () => {
    const { mw, ctx, commands } = probeSetup()
    judgeCalls.length = 0
    const c = ctx('todo 那件进展怎么样')
    const intent = await mw.probe(c)
    const asked = judgeCalls.length
    Object.assign(c, { intent })
    let nexted = false
    await mw(c, async () => { nexted = true })
    expect(nexted).toBe(false); expect(commands.length + 1).toBeGreaterThan(0); expect(judgeCalls.length).toBe(asked)
  })
  it('数字越界这一种"探针说是、执行却放行"的分支,探针直接算作 chat', async () => {
    const { mw, ctx, run } = probeSetup()
    await run('DATA.md 那件怎么样了')  // 问了"哪一件"(两个选项)
    expect(await mw.probe(ctx('9'))).toBeNull()
    expect((await run('9')).nexted).toBe(true)
  })
})
