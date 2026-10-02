import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryFS } from './fs-api'
import {
  TODAY_DRAFT_FILENAME, TODAY_DRAFT_MAX_CHARS, TODAY_DRAFT_LINE_MAX,
  profileAdditions, appendToDraft, consumeDraft, recordProfileWrite, readDraftForPrompt, chatOfProfilePath,
} from './today-draft'

const len = (s: string) => Array.from(s).length

describe('profileAdditions', () => {
  it('returns only lines that are new in the after-text, normalised to "- text"', () => {
    const before = '# 主人\n- 叫大人\n- 做 wechat-cc\n'
    const after = '# 主人\n- 叫大人\n- 做 wechat-cc\n- 下周三去上海出差\n* 最近在戒咖啡\n1. 周五前给 X 回话\n'
    expect(profileAdditions(before, after)).toEqual(['下周三去上海出差', '最近在戒咖啡', '周五前给 X 回话'])
  })
  it('first write (no previous file) counts every content line', () => {
    expect(profileAdditions(null, '- a\n- b')).toEqual(['a', 'b'])
  })
  it('skips headings, blank lines, HTML comments, code fences and lines that only moved', () => {
    const before = '- 甲\n- 乙\n'
    const after = '## 新标题\n\n<!-- 注释 -->\n```\n- 乙\n- 甲\n'
    expect(profileAdditions(before, after)).toEqual([])
  })
  it('a list marker or whitespace change is not a new fact', () => {
    expect(profileAdditions('- 喜欢猫', '*   喜欢猫  ')).toEqual([])
  })
  it('dedupes repeats within the same write', () => {
    expect(profileAdditions('', '- x\n- x\n')).toEqual(['x'])
  })
})

describe('appendToDraft', () => {
  it('appends new lines as a "- " list, skipping ones already in the draft', () => {
    expect(appendToDraft('- a\n', ['a', 'b'])).toBe('- a\n- b\n')
  })
  it(`caps the draft at ${TODAY_DRAFT_MAX_CHARS} characters by dropping the OLDEST lines`, () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i}条` + '记'.repeat(40))
    const out = appendToDraft('', lines)
    expect(len(out)).toBeLessThanOrEqual(TODAY_DRAFT_MAX_CHARS)
    expect(out).toContain('第19条')          // newest kept
    expect(out).not.toContain('第0条')        // oldest dropped
  })
  it(`trims a single over-long line to ${TODAY_DRAFT_LINE_MAX} characters so one write cannot evict everything`, () => {
    const out = appendToDraft('- 旧的\n', ['长'.repeat(1000)])
    expect(out).toContain('- 旧的')
    expect(len(out.split('\n')[1]!)).toBeLessThanOrEqual(TODAY_DRAFT_LINE_MAX + 2)
  })
  it('nothing to add ⇒ unchanged', () => {
    expect(appendToDraft('- a\n', [])).toBe('- a\n')
  })
})

describe('consumeDraft', () => {
  it('removes exactly the lines the nightly read, keeps lines added during the run', () => {
    expect(consumeDraft('- a\n- b\n- c\n', '- a\n- b\n')).toBe('- c\n')
  })
  it('everything consumed ⇒ empty string', () => {
    expect(consumeDraft('- a\n', '- a\n')).toBe('')
  })
})

describe('chatOfProfilePath', () => {
  it('matches <chat>/profile.md in any spelling that resolves to it', () => {
    for (const p of ['owner/profile.md', './owner/profile.md', 'owner//profile.md', 'owner/x/../profile.md', 'owner/Profile.md', 'owner/profile.md/']) {
      expect(chatOfProfilePath(p)).toBe('owner')
    }
  })
  it('does not match other files', () => {
    for (const p of ['profile.md', 'owner/notes/profile.md', 'owner/memory.md', 'owner/profile.md.bak']) {
      expect(chatOfProfilePath(p)).toBeNull()
    }
  })
})

describe('recordProfileWrite / readDraftForPrompt', () => {
  let rootDir: string
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'today-draft-'))
    mkdirSync(join(rootDir, 'owner'), { recursive: true })
  })
  it('appends profile additions to <chat>/today-draft.md once memory.md exists', () => {
    writeFileSync(join(rootDir, 'owner', 'memory.md'), '## 关于你\n- 叫大人\n')
    const fs = makeMemoryFS({ rootDir })
    expect(recordProfileWrite(fs, 'owner', '- 叫大人\n', '- 叫大人\n- 下周三去上海\n')).toBe(true)
    expect(readFileSync(join(rootDir, 'owner', TODAY_DRAFT_FILENAME), 'utf8')).toBe('- 下周三去上海\n')
    expect(readDraftForPrompt(fs, 'owner')).toBe('- 下周三去上海')
  })
  it('does nothing while there is no memory.md (profile.md itself is still injected then)', () => {
    const fs = makeMemoryFS({ rootDir })
    expect(recordProfileWrite(fs, 'owner', '', '- 新事\n')).toBe(false)
    expect(existsSync(join(rootDir, 'owner', TODAY_DRAFT_FILENAME))).toBe(false)
  })
  it('readDraftForPrompt is empty when the draft is missing or blank', () => {
    const fs = makeMemoryFS({ rootDir })
    expect(readDraftForPrompt(fs, 'owner')).toBe('')
    writeFileSync(join(rootDir, 'owner', TODAY_DRAFT_FILENAME), '  \n')
    expect(readDraftForPrompt(fs, 'owner')).toBe('')
  })
})
