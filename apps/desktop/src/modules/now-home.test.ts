import { describe, it, expect } from 'vitest'
import { greetingFor, ccPresence, nowStatusLine, latestCCLine, ccBubblePreview, waitingRows, waitingHeader } from './now-home.js'

describe('greetingFor', () => {
  it('三档,与手机同一套钟点', () => {
    expect(greetingFor(5)).toBe('早上好'); expect(greetingFor(11)).toBe('早上好')
    expect(greetingFor(12)).toBe('下午好'); expect(greetingFor(17)).toBe('下午好')
    expect(greetingFor(18)).toBe('晚上好'); expect(greetingFor(4)).toBe('晚上好')
  })
})
describe('ccPresence', () => {
  const p = (presence: string) => ({ presence, activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })
  it('拉到真数据就在身边(外发 offline 只影响微信,不变暗)', () => {
    for (const s of ['ok', 'degraded', 'offline']) expect(ccPresence(p(s))).toBe('here')
  })
  it('拉不到 / 还没拉 ⇒ 不在身边', () => { expect(ccPresence(p('down'))).toBe('away'); expect(ccPresence(null)).toBe('away') })
})
describe('latestCCLine', () => {
  it('工作台通知留在完整记录里,不替代首页的 CC 原话', () => {
    expect(latestCCLine([{ role: 'cc', text: '在呢。', at: 1 }, { role: 'cc', text: '任务完成', at: 2, source: 'workbench' }]))
      .toEqual({ text: '在呢。', at: 1 })
    expect(latestCCLine([{ role: 'cc', text: '任务完成', source: 'workbench' }])).toBeNull()
  })
  it('最近一条 CC 的、非占位、非空的话', () => {
    expect(latestCCLine([{ role: 'cc', text: '早', at: 1 }, { role: 'user', text: '在吗', at: 2 }, { role: 'cc', text: '…', pending: true }, { role: 'cc', text: '行程好了', at: 3 }, { role: 'error', text: '失败' }] as any))
      .toEqual({ text: '行程好了', at: 3 })
  })
  it('只有占位 / 空 / 没有 ⇒ null', () => {
    expect(latestCCLine([])).toBeNull()
    expect(latestCCLine([{ role: 'cc', text: '…', pending: true }] as any)).toBeNull()
    expect(latestCCLine([{ role: 'user', text: 'hi' }] as any)).toBeNull()
  })
})
describe('ccBubblePreview', () => {
  it('短回复完整展示,多句回复摘出完整第一句', () => {
    expect(ccBubblePreview('在呢。')).toEqual({ text: '在呢。', shortened: false })
    expect(ccBubblePreview('行程整理好了，你看看？\n\n有两个备选方案。')).toEqual({ text: '行程整理好了，你看看？', shortened: true })
  })
  it('跳过引子,把列表原话与 Markdown 整理成能读的一句', () => {
    expect(ccBubblePreview('已同步，最新两条如下：\n\n1. **周五去上海。**\n2. 周日回来。'))
      .toEqual({ text: '周五去上海。', shortened: true })
    expect(ccBubblePreview('The trip is ready. There are two options.')).toEqual({ text: 'The trip is ready.', shortened: true })
  })
  it('超长无标点回复有长度上限,短的无标点回复不凭空添内容', () => {
    expect(ccBubblePreview('收到')).toEqual({ text: '收到', shortened: false })
    expect(ccBubblePreview('很'.repeat(200))).toEqual({ text: `${'很'.repeat(120)}…`, shortened: true })
  })
  it('图片和代码预览不留下图片标记或围栏语言名', () => {
    expect(ccBubblePreview('![结果](artifact.png)')).toEqual({ text: '结果', shortened: false })
    expect(ccBubblePreview('![](artifact.png)').text).toBe('图片')
    expect(ccBubblePreview('```ts\nconst ready = true\n```')).toEqual({ text: 'const ready = true', shortened: false })
  })
})
describe('waitingRows', () => {
  const task = (id: string, perm: number, q: number) => ({ id, title: `任务 ${id}`, providerId: 'claude', pendingPermissionCount: perm, pendingQuestionCount: q, attentionKey: '[]' })
  it('没带原文:有权限 ⇒ 看清楚;只有问题 ⇒ 回答;说明是计数', () => {
    expect(waitingRows({ tasks: [task('a', 1, 1), task('b', 0, 2)], stale: false })).toEqual([
      { id: 'a', title: '任务 a', detail: '1 项权限 · 1 个问题', go: '看清楚' },
      { id: 'b', title: '任务 b', detail: '2 个问题', go: '回答' },
    ])
  })
  it('带原文(attention.first)⇒ 标题是问题 / 权限本身,说明是任务标题;多于一项时补「共 N 项」;按钮跟着第一件走', () => {
    const withFirst = (t: any, kind: string, text: string) => ({ ...t, first: { kind, text } })
    expect(waitingRows({ tasks: [
      withFirst(task('a', 0, 1), 'question', '可以安装图片处理组件吗?'),
      withFirst(task('b', 1, 1), 'permission', 'Bash: npm install sharp'),
    ], stale: false })).toEqual([
      { id: 'a', title: '可以安装图片处理组件吗?', detail: '任务 a', go: '回答' },
      { id: 'b', title: 'Bash: npm install sharp', detail: '任务 b · 共 2 项', go: '看清楚' },
    ])
  })
  it('原文缺失 / 空 ⇒ 退回任务标题 + 计数(旧 daemon 也能用)', () => {
    expect(waitingRows({ tasks: [{ ...task('a', 1, 0), first: null }, { ...task('b', 1, 0), first: { kind: 'permission', text: ' ' } }] as any, stale: false })).toEqual([
      { id: 'a', title: '任务 a', detail: '1 项权限', go: '看清楚' },
      { id: 'b', title: '任务 b', detail: '1 项权限', go: '看清楚' },
    ])
  })
  it('读不到 / 过期 ⇒ 空(不显示旧的「等你」)', () => {
    expect(waitingRows(null)).toEqual([])
    expect(waitingRows({ tasks: [task('a', 1, 0)], stale: true })).toEqual([])
  })
})

describe('waitingHeader(终审 M3:读不到不等于没有)', () => {
  const task = { id: 'a', title: 't', providerId: 'claude', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '[]' }
  it('有事 ⇒ 「N 件事等你」;没有 ⇒ 不显示;还没拉到第一拍 ⇒ 不显示', () => {
    expect(waitingHeader({ tasks: [task, { ...task, id: 'b' }], stale: false })).toEqual({ hidden: false, unknown: false, title: '2 件事等你' })
    expect(waitingHeader({ tasks: [], stale: false })).toEqual({ hidden: true, unknown: false, title: '' })
    expect(waitingHeader(null)).toEqual({ hidden: true, unknown: false, title: '' })
  })
  it('读不到 / 过期 ⇒ 灰字「暂时不知道有没有等你的事」,不能悄悄消失', () => {
    expect(waitingHeader({ tasks: [task], stale: true })).toEqual({ hidden: false, unknown: true, title: '暂时不知道有没有等你的事' })
    expect(waitingHeader({ tasks: [], stale: true })).toEqual({ hidden: false, unknown: true, title: '暂时不知道有没有等你的事' })
  })
})

describe('nowStatusLine', () => {
  const p = (presence: string) => ({ presence })
  it('presence 够不着 ⇒ 红点 + 不在身边,即使 doctor 说 daemon 活着(与 CC 变暗同一信号)', () => {
    expect(nowStatusLine({ alive: true }, p('down'))).toEqual({ cls: 'bad', text: 'CC 不在身边' })
  })
  it('还没拉到(doctor 或 presence 尚未第一拍)⇒ 灰点「正在连接…」,既不报绿也不报红', () => {
    expect(nowStatusLine(null, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine({ alive: true }, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine(null, p('ok'))).toEqual({ cls: 'unknown', text: '正在连接…' })
  })
  it('daemon 没跑 ⇒ 红', () => { expect(nowStatusLine({ alive: false }, p('ok'))).toEqual({ cls: 'bad', text: 'CC 没在运行' }) })
  it('两边都通才绿', () => { expect(nowStatusLine({ alive: true }, p('ok'))).toEqual({ cls: 'ok', text: 'CC 在家 · 运行中' }) })
})
