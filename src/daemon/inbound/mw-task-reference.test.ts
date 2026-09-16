import { describe, it, expect } from 'vitest'
import { makeMwTaskReference, type TaskReferenceMwDeps } from './mw-task-reference'
import type { TaskCandidate } from '../../core/workbench/task-reference'

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
  it('没有待选问题时回一个裸数字 ⇒ 提示一句,绝不变成某个任务的补充', async () => {
    const { run, commands, sent } = setup()
    await run('整理 TODO 那件继续') // 设了焦点
    const r = await run('2')
    expect(r.consumed).toBe('workbench')
    expect(commands.filter(c => c.includes('补充 2'))).toEqual([])
    expect(sent.at(-1)).toMatch(/没有待选/)
  })
  it('待选窗口 30 分钟:8 分钟后回数字仍算选择', async () => {
    const { run, commands, advance } = setup()
    await run('project-b 那个继续')
    advance(8 * 60_000)
    await run('2')
    expect(commands).toHaveLength(1); expect(commands[0]).toMatch(/^任务 (f3c7234a|5c12e75a) 补充 project-b 那个继续$/)
  })
  it('主人从微信第一次点名某件事 ⇒ 顺手为它开提醒(每件一次),失败/完成才到得了手机', async () => {
    const { run, commands, watches } = setup()
    await run('整理 TODO 那件继续')
    await run('顺便把注释也删了')
    expect(watches).toEqual(['任务 a85aec02 提醒我'])
    expect(commands).toEqual(['任务 a85aec02 补充 整理 TODO 那件继续', '任务 a85aec02 补充 顺便把注释也删了'])
  })
})
