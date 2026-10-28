/**
 * G2 金样:`render(parse(夹具))` 与 G0 用今天的代码生成的金样逐字节相等(设计稿
 * docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。夹具与金样在 src/test-support/fixtures/memory/。
 * 同一组还要经店面再走一遍(src/adapters/store/memory-facts.test.ts):行进表、读出来、渲染,仍然逐字节相等。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMemoryDoc } from '../../features/memory/curated-doc'
import { parseOwnerDoc } from '../../lib/memory-owner'
import { factsFromMemoryDoc, factsFromOwnerDoc, type NewMemoryFact } from './facts'
import { renderMemoryForPrompt, renderMemoryMd, renderOwnerForPrompt, renderOwnerMd, type RenderableFact } from './render'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-support', 'fixtures', 'memory')
const STAMP = '2026-10-25T03:00:00.000Z'   // 和 src/features/memory/memory-golden.test.ts 生成金样时的戳一样
const golden = (rel: string) => readFileSync(join(FIXTURES, 'golden', rel), 'utf8')

/** 夹具里一个对话 → 行(今天的解析器 + 纯转换);被 `替换:` 指到的更正补一行墓碑(G3 导入时先导 corrections.md,效果相同)。 */
function rowsOf(name: string): NewMemoryFact[] {
  const chat = `fixture-${name}`
  const read = (f: string) => { const p = join(FIXTURES, 'chats', name, f); return existsSync(p) ? readFileSync(p, 'utf8') : null }
  const mem = read('memory.md'), own = read('owner.md')
  const memRows = mem === null ? [] : factsFromMemoryDoc(chat, parseMemoryDoc(mem), 'import')
  const ownRows = own === null ? [] : factsFromOwnerDoc(chat, parseOwnerDoc(own))
  const tombstones = ownRows.flatMap(r => r.replacesKey
    ? [{ chatId: chat, key: r.replacesKey, doc: 'owner' as const, subject: 'owner', text: '(被替换的那句)', status: 'retracted' as const, source: 'legacy_correction' as const }]
    : [])
  return [...tombstones, ...memRows, ...ownRows]
}
const asViews = (rows: NewMemoryFact[]): RenderableFact[] =>
  rows.map(r => ({ key: r.key, doc: r.doc, section: r.section ?? null, ord: r.ord ?? 0, text: r.text, status: r.status, seenAt: r.seenAt ?? null, origin: r.origin ?? null, replacesKey: r.replacesKey ?? null }))

describe.each(['owner', 'guest', 'empty'])('render(parse(%s fixture)) equals the G0 golden byte for byte', (name) => {
  const rows = asViews(rowsOf(name))
  it('memory.md', () => expect(renderMemoryMd(rows, STAMP)).toBe(golden(`${name}/memory.md`)))
  it('owner.md', () => expect(renderOwnerMd(rows)).toBe(golden(`${name}/owner.md`)))
  it('the curated-memory prompt section', () => expect(renderMemoryForPrompt(rows)).toBe(golden(`${name}/prompt-curated.txt`)))
})

describe('render details', () => {
  it('the owner\'s words prompt equals the golden in the owner chat (the guest gate is the caller\'s, not render\'s)', () => {
    expect(renderOwnerForPrompt(asViews(rowsOf('owner')))).toBe(golden('owner/prompt-owner.txt'))
    expect(golden('guest/prompt-owner.txt')).toBe('')
  })

  it('only active rows render: a retracted entry disappears from memory.md and the prompt, its neighbours stay put', () => {
    const rows = asViews(rowsOf('owner'))
    const target = rows.find(r => r.key === 'm:dead02')!
    const after = rows.map(r => (r === target ? { ...r, status: 'retracted' as const } : r))
    expect(renderMemoryMd(after, STAMP)).toBe(golden('owner/memory.md').replace('- 年糕是狸花猫 <!-- m:dead02 · 2026-10-21 -->\n', ''))
    expect(renderMemoryForPrompt(after)).not.toContain('年糕是狸花猫')
  })

  it('order comes from ord, not from input order', () => {
    const rows = asViews(rowsOf('guest'))
    expect(renderMemoryMd([...rows].reverse(), STAMP)).toBe(golden('guest/memory.md'))
  })

  it('caps the owner\'s words in the prompt like today', () => {
    const long = 'x'.repeat(2000)
    const out = renderOwnerForPrompt([{ key: 'o:aaaa', doc: 'owner', section: null, ord: 0, text: long, status: 'active', seenAt: '2026-10-26', origin: 'owner', replacesKey: null }])
    expect(out).toBe(`- ${long}`.slice(0, 1500) + '\n(已截断)')
  })

  // 2026-10 变异基线:clean(写 owner.md 前拆掉原话里的 `<!--` / `-->`、折叠空白)任何一环清空都不红。
  // owner.md 一行 = 原话 + 一个 HTML 注释尾注(o:<id> · 日期 · 来源);原话里带注释的开头 / 收尾,在任何按 HTML 读的地方
  // (预览、编辑器)尾注都会被提前合上 / 吞掉;带换行则整行拆成两行,读回来编号就丢了。
  it('owner.md:原话里的注释开头 / 收尾和换行不会弄坏那一行的尾注,读回来编号还在', () => {
    const said = [
      '别再叫我 --> 大人',
      '粘进来半截 <!-- o:zzzz · 2026-01-01 · owner',
      '整段尾注 <!-- o:zzzz · 2026-01-01 · owner --> 也粘进来了',
      '第一行\n第二行\t 第三行',
      '  前后有空白  ',
    ]
    const rows: RenderableFact[] = said.map((text, i) => ({ key: `o:abc${i}`, doc: 'owner', section: null, ord: i, text, status: 'active', seenAt: '2026-10-26', origin: 'owner', replacesKey: null }))
    const md = renderOwnerMd(rows)
    const lines = md.split('\n').filter(l => l.startsWith('- '))
    expect(lines.length).toBe(said.length)
    for (const l of lines) {
      expect(l.split('<!--').length - 1, l).toBe(1)
      expect(l.split('-->').length - 1, l).toBe(1)
      expect(l.endsWith('-->'), l).toBe(true)
    }
    const back = parseOwnerDoc(md)
    expect(back.extra).toEqual([])
    expect(back.assertions.map(a => a.id)).toEqual(['abc0', 'abc1', 'abc2', 'abc3', 'abc4'])
    expect(back.assertions[1]!.text).toBe('粘进来半截 <!— o:zzzz · 2026-01-01 · owner')
    expect(lines[4]).toBe('- 前后有空白 <!-- o:abc4 · 2026-10-26 · owner -->')
    expect(back.assertions[0]!.text).toBe('别再叫我 —> 大人')
    expect(back.assertions[3]!.text).toBe('第一行 第二行 第三行')
  })
})
