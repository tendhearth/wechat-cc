import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OWNER_FILENAME, parseOwnerDoc, readOwnerDoc, renderOwnerForPrompt, serializeOwnerDoc, writeOwnerAssertions, type OwnerDoc } from './memory-owner'

const doc: OwnerDoc = {
  assertions: [
    { id: 'a1b2', text: '我不喝咖啡', date: '2026-10-23', origin: 'overview' },
    { id: 'c3d4', text: '周末不谈工作', date: '2026-10-23', origin: 'memory', replaces: 'k9-x' },
  ],
  extra: [],
}

describe('owner.md', () => {
  it('写出去再读回来一模一样', () => {
    expect(parseOwnerDoc(serializeOwnerDoc(doc))).toEqual(doc)
  })

  it('认不出的行原样留在 extra,不丢', () => {
    const got = parseOwnerDoc(serializeOwnerDoc(doc) + '主人随手写的一行\n')
    expect(got.assertions).toHaveLength(2)
    expect(got.extra).toEqual(['主人随手写的一行'])
    expect(serializeOwnerDoc(got)).toContain('主人随手写的一行')
  })

  it('原话里的 --> 和换行不会把尾注拆坏', () => {
    const tricky: OwnerDoc = { assertions: [{ id: 'e5f6', text: '箭头 --> 和\n换行', date: '2026-10-23', origin: 'owner' }], extra: [] }
    const back = parseOwnerDoc(serializeOwnerDoc(tricky))
    expect(back.assertions).toHaveLength(1)
    expect(back.assertions[0]!.text).toBe('箭头 —> 和 换行')
  })

  it('注入只给原话,不带尾注;没有原话 ⇒ 空', () => {
    expect(renderOwnerForPrompt(doc)).toBe('- 我不喝咖啡\n- 周末不谈工作')
    expect(renderOwnerForPrompt({ assertions: [], extra: [] })).toBe('')
  })

  it('写下去能读回来(过期见 fs-api.test)', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-md-'))
    try {
      writeOwnerAssertions(root, doc)
      expect(readFileSync(join(root, OWNER_FILENAME), 'utf8')).toContain('我不喝咖啡')
      expect(readOwnerDoc(root)).toEqual(doc)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('没有文件 ⇒ 空的', () => {
    expect(readOwnerDoc(join(tmpdir(), 'no-such-owner-dir'))).toEqual({ assertions: [], extra: [] })
  })
})
