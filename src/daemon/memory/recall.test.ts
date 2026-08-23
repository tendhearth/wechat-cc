import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recallFromMemory } from './recall'

describe('recallFromMemory', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'own-recall-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  function seed(chatId: string, files: Record<string, string>) {
    const root = join(stateDir, 'memory', chatId)
    mkdirSync(join(root, 'notes'), { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(root, rel), content)
    }
  }

  it('finds matching lines across memory files, tagged with their file', () => {
    seed('c1', {
      'preferences.md': '- 喜欢简短回复\n- 上海出差时倾向早上开会\n',
      'notes/travel.md': '# 出行\n下个月去上海出差三天\n',
    })
    const hits = recallFromMemory(stateDir, 'c1', '上海出差的安排')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some(h => h.includes('notes/travel.md') && h.includes('上海出差三天'))).toBe(true)
    expect(hits.some(h => h.includes('preferences.md'))).toBe(true)
  })

  it('excludes profile.md and knowledge.md (already injected every turn)', () => {
    seed('c1', {
      'profile.md': '常驻上海出差的人\n',
      'knowledge.md': '上海出差相关事实\n',
      'agenda.md': '- [ ] due:2026-09-01 问上海出差报销\n',
    })
    const hits = recallFromMemory(stateDir, 'c1', '上海出差')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('agenda.md')
  })

  it('caps results at limit, best matches first', () => {
    seed('c1', {
      'notes/a.md': '上海出差住宿偏好如家\n只提上海\n无关行数\n',
    })
    const hits = recallFromMemory(stateDir, 'c1', '上海出差住宿', 1)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('住宿')
  })

  it('no memory dir / no match / weird chatId → empty, never throws', () => {
    expect(recallFromMemory(stateDir, 'no-such-chat', '上海出差')).toEqual([])
    seed('c1', { 'notes/a.md': '完全无关的内容\n' })
    expect(recallFromMemory(stateDir, 'c1', '北极科考站')).toEqual([])
    expect(recallFromMemory(stateDir, '../escape', '上海出差')).toEqual([])
    expect(recallFromMemory(stateDir, 'a/b', '上海出差')).toEqual([])
  })

  it('truncates long matched lines', () => {
    seed('c1', { 'notes/a.md': '上海出差' + 'x'.repeat(500) + '\n' })
    const hits = recallFromMemory(stateDir, 'c1', '上海出差')
    expect(hits[0]!.length).toBeLessThan(220)
  })
})
