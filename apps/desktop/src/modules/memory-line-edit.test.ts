// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { DERIVED_MEMORY_PATHS, bulkConfirmText, bulkGate, isDerivedMemoryPath, collectLines, editOutcome, isLineEditablePath, lineViewFor, linesUnchanged, memoryEditBody, memoryEditFailure, renderLineEditor, renderOwnerBlock } from './memory-line-edit.js'

const view = (lines: any[], extra: Record<string, unknown> = {}): any => ({ ok: true, chatId: 'owner@im.wechat', path: 'memory.md', baseHash: 'a'.repeat(64), generatedAt: null, stale: false, lines, ...extra })
const owned = { text: '我不喝咖啡', origin: 'owner', assertionId: 'o1', editedAt: '2026-10-23', replaces: { correctionId: 'c1', text: '喜欢美式' } }
const gen = (text: string, lineKey: string) => ({ text, origin: 'generated', lineKey })

function mount(v: any) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  renderLineEditor(root, v)
  return root
}

describe('which files use the line editor', () => {
  it('only the three owner-editable paths', () => {
    expect(['_overview.md', 'memory.md', 'owner.md'].every(isLineEditablePath)).toBe(true)
    expect(isLineEditablePath('notes/a.md')).toBe(false)
    expect(isLineEditablePath('profile.md')).toBe(false)
  })
  it('a view is only used for the chat it belongs to — another chat keeps whole-file editing', () => {
    expect(lineViewFor(view([]), 'owner@im.wechat')).not.toBeNull()
    expect(lineViewFor(view([]), 'friend@im.wechat')).toBeNull()
    expect(lineViewFor({ ok: false, code: 'memory_no_owner' }, 'owner@im.wechat')).toBeNull()
    expect(lineViewFor({ ...view([]), chatId: undefined }, 'owner@im.wechat')).toBeNull()
  })
})

describe('the editor keeps each line with its key', () => {
  it('unchanged rows come back exactly as view gave them', () => {
    const v = view([owned, gen('住在上海', 'm:7')])
    const root = mount(v)
    const lines = collectLines(root)
    expect(lines).toEqual([{ text: '我不喝咖啡', assertionId: 'o1' }, { text: '住在上海', lineKey: 'm:7' }])
    expect(linesUnchanged(lines, v)).toBe(true)
  })
  it('an edited row keeps its key; a removed row is simply absent; an added row has no key', () => {
    const root = mount(view([gen('住在上海', 'm:7'), gen('养了一只猫', 'h:abc')]))
    ;(root.querySelector('.memory-line-input') as HTMLInputElement).value = '住在杭州'
    ;(root.querySelectorAll('.memory-line-remove')[1] as HTMLElement).click()
    ;(root.querySelector('.memory-line-add') as HTMLElement).click()
    const inputs = root.querySelectorAll('.memory-line-input')
    ;(inputs[inputs.length - 1] as HTMLInputElement).value = '周末爬山'
    expect(collectLines(root)).toEqual([{ text: '住在杭州', lineKey: 'm:7' }, { text: '周末爬山' }])
  })
  it('an added row left empty is not sent', () => {
    const root = mount(view([gen('住在上海', 'm:7')]))
    ;(root.querySelector('.memory-line-add') as HTMLElement).click()
    expect(collectLines(root)).toEqual([{ text: '住在上海', lineKey: 'm:7' }])
  })
  it('re-rendering the same container does not stack click handlers (one click adds one row)', () => {
    const v = view([gen('住在上海', 'm:7')])
    const root = mount(v)
    renderLineEditor(root, v)
    ;(root.querySelector('.memory-line-add') as HTMLElement).click()
    expect(root.querySelectorAll('.memory-line')).toHaveLength(2)
  })
  it('owner lines show 你改过 and what they replaced; generated lines do not', () => {
    const root = mount(view([owned, gen('住在上海', 'm:7')]))
    const rows = root.querySelectorAll('.memory-line')
    expect(rows[0]!.textContent).toContain('你改过')
    expect(rows[0]!.textContent).toContain('原来是:喜欢美式')
    expect(rows[1]!.textContent).not.toContain('你改过')
  })
  it('text is escaped, never rendered as HTML', () => {
    const root = mount(view([gen('<img src=x onerror=alert(1)>', 'h:x')]))
    expect(root.querySelector('img')).toBeNull()
    expect((root.querySelector('.memory-line-input') as HTMLInputElement).value).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('read-only owner block', () => {
  it('memory.md shows the owner lines on top; the overview already has its own section', () => {
    expect(renderOwnerBlock(view([owned]) as any)).toContain('你写的')
    expect(renderOwnerBlock(view([owned], { path: '_overview.md' }) as any)).toBe('')
    expect(renderOwnerBlock(view([owned], { path: 'owner.md' }) as any)).toBe('')
    expect(renderOwnerBlock(view([gen('住在上海', 'm:7')]) as any)).toBe('')
  })
})

describe('memory edit body (POST /v1/memory/edit)', () => {
  it('same fields `wechat-cc memory edit` sent; confirmBulk only after the owner confirmed', () => {
    expect(memoryEditBody('memory.md', 'b'.repeat(64), [{ text: '住在杭州', lineKey: 'm:7' }], false))
      .toEqual({ path: 'memory.md', baseHash: 'b'.repeat(64), lines: [{ text: '住在杭州', lineKey: 'm:7' }] })
    expect(memoryEditBody('memory.md', 'b'.repeat(64), [], true)).toEqual({ path: 'memory.md', baseHash: 'b'.repeat(64), lines: [], confirmBulk: true })
  })
  it('a failed host call becomes the { ok:false, code } the CLI used to print', () => {
    expect(memoryEditFailure(new Error('memory_no_owner'))).toEqual({ ok: false, code: 'memory_no_owner' })
    expect(memoryEditFailure(new Error('request error: connection refused'))).toEqual({ ok: false, code: 'daemon_unreachable' })
    expect(editOutcome(memoryEditFailure(new Error('read /x/internal-api-info.json: No such file'))).message).toBe('需要守护进程运行后才能保存')
  })
})

describe('what the desktop does with each answer', () => {
  it('saved: says how many became corrections / owner words', () => {
    expect(editOutcome({ ok: true, corrections: [{}], assertions: [{}, {}], regenerate: 'queued' })).toEqual({ status: 'saved', message: expect.stringContaining('1 条当成说错了,2 条记成你说的') })
  })
  it('changed underneath or a stale key ⇒ reread and edit again', () => {
    expect(editOutcome({ ok: false, code: 'memory_changed' }).status).toBe('reload')
    expect(editOutcome({ ok: false, code: 'memory_edit_stale_key' }).status).toBe('reload')
  })
  it('bulk ⇒ ask first, naming deleted and rewritten separately', () => {
    const o = editOutcome({ ok: false, code: 'memory_edit_bulk', count: 6, deleted: 2, rewritten: 4 })
    expect(o.status).toBe('confirm')
    expect(o.message).toContain('删掉 2 条、改写 4 条')
    expect(bulkConfirmText({ count: 6, deleted: 6, rewritten: 0 })).toContain('删掉 6 条')
    expect(bulkConfirmText({ count: 6, deleted: 6, rewritten: 0 })).not.toContain('改写')
  })
  it('too large / no owner / daemon down / unknown ⇒ a plain sentence, nothing written', () => {
    expect(editOutcome({ ok: false, code: 'memory_edit_too_large', limit: { lines: 200, bytes: 65536, lineChars: 500 } }).message).toContain('最多 200 行')
    expect(editOutcome({ ok: false, code: 'memory_no_owner' }).message).toContain('还没绑定微信主人')
    expect(editOutcome({ ok: false, code: 'daemon_unreachable' }).message).toContain('守护进程')
    expect(editOutcome({ ok: false, code: 'memory_edit_failed' })).toEqual({ status: 'bad', message: '保存失败:memory_edit_failed' })
  })
})

describe('bulk confirmation only covers what the owner was shown', () => {
  const shown = [{ text: '住在杭州', lineKey: 'm:7' }]
  it('first save never confirms', () => {
    expect(bulkGate(null, shown).confirmBulk).toBe(false)
  })
  it('the same lines on the second click ⇒ confirm', () => {
    const first = bulkGate(null, shown)
    expect(bulkGate(first.snapshot, [{ text: '住在杭州', lineKey: 'm:7' }]).confirmBulk).toBe(true)
  })
  it('edited again after the prompt (more deletions, a changed word) ⇒ not confirmed, re-prompt with new counts', () => {
    const first = bulkGate(null, shown)
    expect(bulkGate(first.snapshot, []).confirmBulk).toBe(false)
    expect(bulkGate(first.snapshot, [{ text: '住在苏州', lineKey: 'm:7' }]).confirmBulk).toBe(false)
  })
})

describe('derived files', () => {
  it('match the daemon manifest exactly (kind: derived)', async () => {
    const { MEMORY_ARTIFACTS } = await import('../../../../src/lib/memory-artifacts')
    const derived = Object.entries(MEMORY_ARTIFACTS).filter(([, v]) => (v as any).kind === 'derived').map(([k]) => k).sort()
    expect([...DERIVED_MEMORY_PATHS].sort()).toEqual(derived)
    expect(isDerivedMemoryPath('memory.md')).toBe(false)
  })
})
