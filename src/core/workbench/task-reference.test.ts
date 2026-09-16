import { describe, it, expect } from 'vitest'
import { makeCheapJudge, resolveTaskReference, parseTaskIdFromMessage, focusDeclaration, FOCUS_TTL_MS, type TaskCandidate, type TaskJudge } from './task-reference'

/**
 * 管家式指称解析(spec 2026-09-16):主人在微信里说"那个整理 TODO 的事"、引用一条任务
 * 消息、或声明"接下来说 project-b",CC 要在**活跃候选**里落定是哪件事;落不定就问,
 * 永远不默默押注"最近一件"(导览 §离开电脑:不能凭最近一个任务猜)。
 * 三层:引用锚 → 显式编号 → 名称匹配;声明式焦点在名称匹配之后、模型判断之前;
 * 便宜模型只能从候选里选或说"不确定"。这些层都是纯函数,模型注入。
 */
const NOW = 1_800_000_000_000
const c = (over: Partial<TaskCandidate> & { id: string }): TaskCandidate => ({
  title: '', project: 'proj', path: '/p/proj', providerId: 'claude', phase: 'replied', updatedAt: NOW - 1000, ...over,
})
const todo = c({ id: 'a85aec02', title: '读 NOTES.md,把「本周三件事」整理成一个 TODO.md', project: 'sample-project', path: '/s/sample-project' })
const latency = c({ id: 'f3c7234a', title: '读 DATA.md,回答:哪三个模型在 1 秒以内?', project: 'project-b', path: '/s/project-b', providerId: 'codex' })
const review = c({ id: '5c12e75a', title: '检查 · 读 DATA.md,回答:哪三个模型在 1 秒以内?', project: 'project-b', path: '/s/project-b' })
const all = [todo, latency, review]
const resolve = (text: string, over: Partial<Parameters<typeof resolveTaskReference>[0]> = {}) =>
  resolveTaskReference({ text, candidates: all, nowMs: NOW, ...over })

describe('引用锚:回复 CC 发过的任务消息,归属是确定的', () => {
  it('从被引用消息的「任务 <编号>」头里读出任务', () => {
    expect(parseTaskIdFromMessage('任务 a85aec02：补充已传达给执行者。')).toBe('a85aec02')
    expect(parseTaskIdFromMessage('📁 project-b · 读 DATA.md · Codex\n任务 f3c7234a：已答复')).toBe('f3c7234a')
    expect(parseTaskIdFromMessage('今天天气不错')).toBeNull()
  })
  it('引用优先于一切,即使正文提到了别的项目', async () => {
    const r = await resolve('那 project-b 那个呢?', { quotedText: '任务 a85aec02：整理好了' })
    expect(r).toEqual({ kind: 'task', taskId: 'a85aec02', via: 'quote' })
  })
  it('引用的不是任务消息(没有编号头)⇒ 当作没引用', async () => {
    const r = await resolve('整理 TODO 那件继续', { quotedText: '哈哈' })
    expect(r).toMatchObject({ kind: 'task', taskId: 'a85aec02', via: 'name' })
  })
})

describe('显式编号', () => {
  it('正文里带 8 位编号 ⇒ 直接落定', async () => {
    expect(await resolve('f3c7234a 停止')).toEqual({ kind: 'task', taskId: 'f3c7234a', via: 'id' })
  })
  it('编号不在活跃候选里 ⇒ 不是它', async () => {
    expect((await resolve('deadbeef 停止')).kind).not.toBe('task')
  })
})

describe('名称匹配:在活跃候选里找唯一', () => {
  it('标题片段唯一命中', async () => {
    expect(await resolve('整理 TODO 那件继续')).toEqual({ kind: 'task', taskId: 'a85aec02', via: 'name' })
  })
  it('项目名唯一命中', async () => {
    expect(await resolve('sample-project 的进展?')).toEqual({ kind: 'task', taskId: 'a85aec02', via: 'name' })
  })
  it('项目名命中两件 ⇒ 问,选项只含这两件', async () => {
    const r = await resolve('project-b 那个怎么样了')
    expect(r.kind).toBe('ambiguous')
    expect((r as { options: TaskCandidate[] }).options.map(o => o.id).sort()).toEqual(['5c12e75a', 'f3c7234a'])
  })
  it('执行者名只用来在命中里排歧,不能单独定位', async () => {
    expect(await resolve('project-b 那个 codex 做的')).toEqual({ kind: 'task', taskId: 'f3c7234a', via: 'name' })
    expect((await resolve('codex 呢')).kind).not.toBe('task')
  })
  it('普通聊天 ⇒ none,不劫持', async () => {
    expect(await resolve('今天天气不错')).toEqual({ kind: 'none' })
  })
})

describe('声明式焦点:"接下来说 X"', () => {
  it('识别声明并返回指称短语', () => {
    expect(focusDeclaration('现在说 project-b')).toBe('project-b')
    expect(focusDeclaration('接下来说整理 TODO 那件')).toBe('整理 TODO 那件')
    expect(focusDeclaration('整理 TODO 那件继续')).toBeNull()
  })
  it('声明落到唯一任务 ⇒ set_focus', async () => {
    expect(await resolve('接下来说整理 TODO 那件')).toEqual({ kind: 'set_focus', taskId: 'a85aec02', via: 'name' })
  })
  it('声明落到多件 ⇒ 问', async () => {
    expect((await resolve('现在说 project-b')).kind).toBe('ambiguous')
  })
  it('有未过期焦点、正文没别的锚 ⇒ 归焦点', async () => {
    const focus = { taskId: 'f3c7234a', expiresAt: NOW + FOCUS_TTL_MS }
    expect(await resolve('继续', { focus })).toEqual({ kind: 'task', taskId: 'f3c7234a', via: 'focus' })
  })
  it('焦点过期 ⇒ 不再默认', async () => {
    const focus = { taskId: 'f3c7234a', expiresAt: NOW - 1 }
    expect(await resolve('继续', { focus })).toEqual({ kind: 'none' })
  })
  it('正文明确指向另一件 ⇒ 名称赢过焦点', async () => {
    const focus = { taskId: 'f3c7234a', expiresAt: NOW + FOCUS_TTL_MS }
    expect(await resolve('整理 TODO 那件继续', { focus })).toMatchObject({ kind: 'task', taskId: 'a85aec02', via: 'name' })
  })
})

describe('便宜模型:只能从候选里选,或说不确定', () => {
  const pick = (id: string | null, confident = true): TaskJudge => async () => ({ taskId: id, confident })
  it('名称命中多件时,模型有把握 ⇒ 落定并标 via=judge', async () => {
    expect(await resolve('project-b 那个怎么样了', { judge: pick('5c12e75a') })).toEqual({ kind: 'task', taskId: '5c12e75a', via: 'judge' })
  })
  it('模型没把握 ⇒ 仍然问', async () => {
    expect((await resolve('project-b 那个怎么样了', { judge: pick(null, false) })).kind).toBe('ambiguous')
  })
  it('模型选了不在候选里的编号 ⇒ 视为没把握', async () => {
    expect((await resolve('project-b 那个怎么样了', { judge: pick('deadbeef') })).kind).toBe('ambiguous')
  })
  it('名称零命中、无焦点时才把全体候选交给模型;它说"不是在说任务" ⇒ none', async () => {
    let seen: string[] = []
    const judge: TaskJudge = async ({ candidates }) => { seen = candidates.map(x => x.id); return { taskId: null, confident: true } }
    expect(await resolve('那个延迟表弄完了吗', { judge })).toEqual({ kind: 'none' })
    expect(seen.sort()).toEqual(['5c12e75a', 'a85aec02', 'f3c7234a'])
  })
  it('模型抛错 ⇒ 当作不可用,走没有模型的路', async () => {
    const judge: TaskJudge = async () => { throw new Error('gateway down') }
    expect(await resolve('那个延迟表弄完了吗', { judge })).toEqual({ kind: 'none' })
  })
})

describe('主人真实措辞的 eval 集(确定性各层,模型用假件)', () => {
  const cases: Array<[string, string | 'ask' | 'none']> = [
    ['整理 todo 那件做完了吗', 'a85aec02'],
    ['sample-project 里那个', 'a85aec02'],
    ['project-b 的复核结果', 'ask'],
    ['检查那件怎么说', '5c12e75a'],
    ['帮我看看明天的会', 'none'],
    ['a85aec02 结果', 'a85aec02'],
  ]
  for (const [text, expected] of cases) {
    it(`「${text}」→ ${expected}`, async () => {
      const r = await resolve(text)
      if (expected === 'ask') expect(r.kind).toBe('ambiguous')
      else if (expected === 'none') expect(r.kind).toBe('none')
      else expect(r).toMatchObject({ kind: 'task', taskId: expected })
    })
  }
})

describe('makeCheapJudge:把便宜模型包成只会"选编号或说不确定"的裁判', () => {
  const cands = [todo, latency]
  it('回答一个合法编号 ⇒ 有把握、落到那件;提示词里列出了候选和"0=不是在说任务"', async () => {
    let prompt = ''
    const judge = makeCheapJudge(async p => { prompt = p; return '2' })
    expect(await judge({ text: '延迟那份', candidates: cands })).toEqual({ taskId: 'f3c7234a', confident: true })
    expect(prompt).toContain('1.'); expect(prompt).toContain('2.'); expect(prompt).toContain('0'); expect(prompt).toContain('延迟那份')
  })
  it('回答 0 ⇒ 有把握地说"不是任务"', async () => {
    const judge = makeCheapJudge(async () => '0')
    expect(await judge({ text: '今天天气', candidates: cands })).toEqual({ taskId: null, confident: true })
  })
  it('回答含编号但夹杂废话 ⇒ 只认单独一个数字;多个数字 / 超范围 / 空 ⇒ 没把握', async () => {
    const judge = makeCheapJudge(async () => '我觉得是 1 或 2')
    expect(await judge({ text: 'x', candidates: cands })).toEqual({ taskId: null, confident: false })
    expect(await makeCheapJudge(async () => '9')({ text: 'x', candidates: cands })).toEqual({ taskId: null, confident: false })
    expect(await makeCheapJudge(async () => '')({ text: 'x', candidates: cands })).toEqual({ taskId: null, confident: false })
    expect(await makeCheapJudge(async () => '答案：2')({ text: 'x', candidates: cands })).toEqual({ taskId: 'f3c7234a', confident: true })
  })
})

describe('真机回归 2026-09-16(第一次真账号试用)', () => {
  it('引用的是详情回复(「标题 · <编号>」,没有"任务"二字)也能锚定', () => {
    expect(parseTaskIdFromMessage('📁 project-b · 读 DATA.md · Codex · 已答复\n读 DATA.md,只回答 KIMI 的数值 · 9774656c\n\ncodex · 这一轮已完成')).toBe('9774656c')
    expect(parseTaskIdFromMessage('订单号 · 12345678 请查收')).toBe('12345678') // 8 位十六进制才算
    expect(parseTaskIdFromMessage('价格 · 1234 元')).toBeNull()
  })
  it('焦点指向的任务失败了(仍在候选里)⇒ 仍归它,主人才看得到"需要处理"', async () => {
    const failed = { ...latency, phase: 'failed' }
    const focus = { taskId: failed.id, expiresAt: NOW + FOCUS_TTL_MS }
    expect(await resolveTaskReference({ text: '再加一列百分比', candidates: [todo, failed], nowMs: NOW, focus })).toEqual({ kind: 'task', taskId: 'f3c7234a', via: 'focus' })
  })
})

describe('评审回归(2026-09-16 独立评审的反例)', () => {
  it('名称匹配要有把握:单个泛二字词命中不算 —— 普通聊天不能被吞成任务', async () => {
    for (const chat of ['本周有空吗', '我周三有个会', '帮我整理一下日程', '一个都不要']) {
      expect((await resolve(chat)).kind, chat).toBe('none')
    }
  })
  it('有把握的写法仍然命中:强关键词(项目名/目录名/ASCII 词),或至少两个不同的标题片段', async () => {
    expect(await resolve('整理 todo')).toMatchObject({ kind: 'task', taskId: 'a85aec02' })
    expect(await resolve('本周三件事整理成的那份')).toMatchObject({ kind: 'task', taskId: 'a85aec02' })
    expect(await resolve('sample-project')).toMatchObject({ kind: 'task', taskId: 'a85aec02' })
  })
  it('"先说一下/现在说说"不是焦点声明落不到任务时 ⇒ 放行,不列全部候选', async () => {
    expect(await resolve('先说一下,明天我不在')).toEqual({ kind: 'none' })
    expect(await resolve('现在说说你今天干了什么')).toEqual({ kind: 'none' })
  })
  it('零命中时,没有"任务感"线索的消息不问模型 —— 普通聊天不付 LLM 往返', async () => {
    let calls = 0
    const judge: TaskJudge = async () => { calls++; return { taskId: null, confident: true } }
    expect(await resolve('早上好', { judge })).toEqual({ kind: 'none' }); expect(calls).toBe(0)
    expect(await resolve('那个延迟表弄完了吗', { judge })).toEqual({ kind: 'none' }); expect(calls).toBe(1)
  })
  it('模型超时 ⇒ 当作没把握,不会卡住主人的消息', async () => {
    const judge: TaskJudge = () => new Promise(() => {})
    const t0 = Date.now()
    expect(await resolve('那个延迟表弄完了吗', { judge, judgeTimeoutMs: 50 })).toEqual({ kind: 'none' })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
