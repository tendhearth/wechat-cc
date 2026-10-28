import { describe, expect, it } from 'vitest'
import { BULK_CORRECTIONS, EDIT_LIMIT, keyGeneratedLines, overviewTextLines, ownerLines, planEdit, textLineKey, type ViewLine } from './memory-edit'

const gen = (texts: string[]) => keyGeneratedLines(texts)
const own = (id: string, text: string): ViewLine => ({ text, origin: 'owner', assertionId: id })
const back = (view: ViewLine[]) => view.map(v => ({ text: v.text, ...(v.lineKey ? { lineKey: v.lineKey } : {}), ...(v.assertionId ? { assertionId: v.assertionId } : {}) }))

describe('lineKey', () => {
  it('同一句话出现两次,两个键不同;在上面插一行,下面的键不变', () => {
    const a = gen(['喜欢美式', '住杭州', '喜欢美式'])
    expect(a[0]!.lineKey).not.toBe(a[2]!.lineKey)
    const b = gen(['新加的一行', '喜欢美式', '住杭州', '喜欢美式'])
    expect(b.slice(1).map(v => v.lineKey)).toEqual(a.map(v => v.lineKey))
  })
  it('空白不算不同', () => {
    expect(textLineKey('喜欢  美式', 0)).toBe(textLineKey(' 喜欢 美式 ', 0))
  })
  it('有编号的条目用编号', () => {
    expect(keyGeneratedLines(['a', 'b'], ['ab12', null]).map(v => v.lineKey)).toEqual(['m:ab12', textLineKey('b', 0)])
  })
})

describe('overviewTextLines', () => {
  it('去掉生成戳、标题、空行、过期提示和「你写的」那一节,列表记号只留正文', () => {
    const md = [
      '<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · 2026-10-23T00:00:00Z -->', '', '> (这份整体理解是 2026-10-22 整理的…)',
      '## 你写的', '- 我不喝咖啡 <!-- o:a1b2 -->', '## 他是谁', '主人做 wechat-cc。', '- 住杭州', '1. 周五回话',
    ].join('\n')
    expect(overviewTextLines(md)).toEqual(['主人做 wechat-cc。', '住杭州', '周五回话'])
  })
})

describe('planEdit', () => {
  const view = [own('a1', '我不喝咖啡'), ...gen(['住杭州', '喜欢美式', '周五回话'])]

  it('原样回来 ⇒ 什么都不做;只改空白也不算', () => {
    expect(planEdit(view, back(view))).toEqual({ ok: true, plan: { corrections: [], assertions: [], removedAssertionIds: [] } })
    const ws = back(view).map(l => ({ ...l, text: ` ${l.text}  ` }))
    expect(planEdit(view, ws)).toEqual({ ok: true, plan: { corrections: [], assertions: [], removedAssertionIds: [] } })
  })

  it('删一行生成的 ⇒ 一条更正、零原话', () => {
    const r = planEdit(view, back(view).filter(l => l.text !== '喜欢美式'))
    expect(r).toEqual({ ok: true, plan: { corrections: [{ text: '喜欢美式', lineKey: view[2]!.lineKey }], assertions: [], removedAssertionIds: [] } })
  })

  it('加一行(没键)⇒ 一条原话、零更正', () => {
    const r = planEdit(view, [...back(view), { text: '周末不谈工作' }])
    expect(r).toEqual({ ok: true, plan: { corrections: [], assertions: [{ text: '周末不谈工作' }], removedAssertionIds: [] } })
  })

  it('改一行生成的 ⇒ 一条更正 + 一条替换它的原话', () => {
    const lines = back(view).map(l => l.text === '喜欢美式' ? { ...l, text: '只喝茶' } : l)
    const r = planEdit(view, lines)
    expect(r).toEqual({ ok: true, plan: { corrections: [{ text: '喜欢美式', lineKey: view[2]!.lineKey }], assertions: [{ text: '只喝茶', replacesIndex: 0 }], removedAssertionIds: [] } })
  })

  it('改自己的原话 ⇒ 旧的成更正、从 owner.md 去掉,新的一条替换它', () => {
    const lines = back(view).map(l => l.assertionId === 'a1' ? { ...l, text: '我只喝无咖啡因的' } : l)
    expect(planEdit(view, lines)).toEqual({ ok: true, plan: {
      corrections: [{ text: '我不喝咖啡', assertionId: 'a1' }], assertions: [{ text: '我只喝无咖啡因的', replacesIndex: 0 }], removedAssertionIds: ['a1'],
    } })
  })

  it('删自己的原话 ⇒ 一条更正 + 从 owner.md 去掉', () => {
    expect(planEdit(view, back(view).filter(l => l.assertionId !== 'a1'))).toEqual({ ok: true, plan: {
      corrections: [{ text: '我不喝咖啡', assertionId: 'a1' }], assertions: [], removedAssertionIds: ['a1'],
    } })
  })

  it('把一行改成空的 = 删掉,不留空原话', () => {
    const lines = back(view).map(l => l.text === '住杭州' ? { ...l, text: '  ' } : l)
    const r = planEdit(view, lines)
    expect(r.ok && r.plan).toEqual({ corrections: [{ text: '住杭州', lineKey: view[1]!.lineKey }], assertions: [], removedAssertionIds: [] })
  })

  it('同文出现两次、删其中一次 ⇒ 恰好一条更正', () => {
    const v = gen(['喜欢美式', '喜欢美式'])
    const r = planEdit(v, [back(v)[0]!])
    expect(r.ok && r.plan.corrections).toEqual([{ text: '喜欢美式', lineKey: v[1]!.lineKey }])
  })

  it('伪造的键 / 同一个键两次 / 两个键都带 ⇒ stale_key', () => {
    expect(planEdit(view, [...back(view), { text: 'x', lineKey: 'h:deadbeefdeadbeef' }])).toEqual({ ok: false, code: 'memory_edit_stale_key' })
    expect(planEdit(view, [...back(view), { text: 'x', assertionId: 'zz' }])).toEqual({ ok: false, code: 'memory_edit_stale_key' })
    expect(planEdit(view, [...back(view), back(view)[1]!])).toEqual({ ok: false, code: 'memory_edit_stale_key' })
    expect(planEdit(view, [{ text: 'x', lineKey: view[1]!.lineKey!, assertionId: 'a1' }])).toEqual({ ok: false, code: 'memory_edit_stale_key' })
  })

  it(`超过 ${BULK_CORRECTIONS} 条更正要确认;确认了就照做`, () => {
    const v = gen(['1', '2', '3', '4', '5', '6'].map(n => `第 ${n} 条记忆`))
    expect(planEdit(v, [])).toEqual({ ok: false, code: 'memory_edit_bulk', count: 6, deleted: 6, rewritten: 0 })
    // 改写也算更正:删 2 条、改写 4 条 ⇒ 分开报
    const mixed = back(v).slice(2).map(l => ({ ...l, text: l.text + '(改过)' }))
    expect(planEdit(v, mixed)).toEqual({ ok: false, code: 'memory_edit_bulk', count: 6, deleted: 2, rewritten: 4 })
    const r = planEdit(v, [], { confirmBulk: true })
    expect(r.ok && r.plan.corrections).toHaveLength(6)
    expect(planEdit(v, back(v).slice(1)).ok).toBe(true)  // 5 条以内不问
  })

  it('超限 ⇒ too_large 带 limit', () => {
    expect(planEdit([], [{ text: '长'.repeat(EDIT_LIMIT.lineChars + 1) }])).toEqual({ ok: false, code: 'memory_edit_too_large', limit: EDIT_LIMIT })
    expect(planEdit([], Array.from({ length: EDIT_LIMIT.lines + 1 }, (_, i) => ({ text: `${i}` })))).toMatchObject({ ok: false, code: 'memory_edit_too_large' })
  })
})

describe('ownerLines', () => {
  it('replaces 展开成旧话;查不到就不带', () => {
    const lines = ownerLines({ assertions: [
      { id: 'a1', text: '只喝茶', date: '2026-10-23', origin: 'overview', replaces: 'c1' },
      { id: 'a2', text: '住杭州', date: '2026-10-23', origin: 'memory', replaces: 'gone' },
    ], extra: [] }, id => id === 'c1' ? '喜欢美式' : null)
    expect(lines).toEqual([
      { text: '只喝茶', origin: 'owner', assertionId: 'a1', editedAt: '2026-10-23', replaces: { correctionId: 'c1', text: '喜欢美式' } },
      { text: '住杭州', origin: 'owner', assertionId: 'a2', editedAt: '2026-10-23' },
    ])
  })
})

describe('wholeFileWriteRefusal(记忆编辑第 4 步)', () => {
  it('生成物谁的都不许整份写;主人的 memory.md / owner.md 不许;别人的 memory.md、主人的笔记照旧', async () => {
    const { wholeFileWriteRefusal } = await import('./memory-edit')
    expect(wholeFileWriteRefusal('_overview.md', 'derived', 'guest@x', 'owner@x')).not.toMatch(/守护进程/) // 那半句由 CLI 看 daemon 通不通再加
    expect(wholeFileWriteRefusal('memory.md', 'source', 'owner@x', 'owner@x')).toMatch(/逐行改/)
    expect(wholeFileWriteRefusal('./Memory.md', 'source', 'owner@x', 'owner@x')).not.toBeNull()
    expect(wholeFileWriteRefusal('memory.md', 'source', 'guest@x', 'owner@x')).toBeNull()
    expect(wholeFileWriteRefusal('profile.md', 'source', 'owner@x', 'owner@x')).toBeNull()
    expect(wholeFileWriteRefusal('memory.md', 'source', 'owner@x', null)).toBeNull()
  })
})
