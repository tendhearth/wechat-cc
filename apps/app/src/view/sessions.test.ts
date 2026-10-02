import { describe, expect, it } from 'vitest'
import { mergeSessionPages, sessionRows } from './sessions'
describe('sessionRows', () => {
  it('meta = 项目名 · 日期;没项目只给日期;没时间给「时间不明」', () => {
    const NOW = new Date(2026, 9, 1, 12).getTime()
    const rows = sessionRows([
      { key: 'k', provider: 'claude', title: 'T', project: 'portfolio', updatedAt: new Date(2026, 8, 30, 9).getTime(), active: true },
      { key: 'k2', provider: 'codex', title: 'U', project: null, updatedAt: null, active: false },
      { key: 'k3', provider: 'codex', title: 'V', project: null, updatedAt: new Date(2026, 8, 30, 9).getTime(), active: false },
    ], NOW, 'zh-Hans')
    expect(rows).toEqual([{ key: 'k', title: 'T', meta: 'portfolio · 9月30日', active: true }, { key: 'k2', title: 'U', meta: '时间不明', active: false }, { key: 'k3', title: 'V', meta: '9月30日', active: false }])
  })
})

describe('mergeSessionPages', () => {
  const r = (key: string) => ({ key, provider: 'claude' as const, title: key, project: null, updatedAt: null, active: false })
  it('按 key 去重,先出现的留下,顺序不变', () => {
    expect(mergeSessionPages([r('a'), r('b')], [r('b'), r('c'), r('c')]).map(x => x.key)).toEqual(['a', 'b', 'c'])
  })
  it('没追加页 ⇒ 原样', () => expect(mergeSessionPages([r('a')], []).map(x => x.key)).toEqual(['a']))
})
