import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correctedTexts, dropCorrectedLines, dropCorrectedValues, purgeCorrectedFromSources, recordRedactions, MIN_CORRECTED_CHARS } from './memory-corrections'

const dirs: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'mem-corr-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('correctedTexts', () => {
  it('reads each corrected sentence; continuation lines (the purge note) are not mistaken for entries', () => {
    const d = fresh()
    writeFileSync(join(d, 'corrections.md'), '- 2026-10-22 主人说这条记错了,整理时不要再写回:[事实] 住在   杭州西湖区\n  (随之从 profile.md 删了 1 行;原文件在 memory-archive/o/corrections/)\n')
    expect([...correctedTexts(d)]).toEqual(['住在 杭州西湖区'])
  })
})

describe('dropCorrectedLines / dropCorrectedValues (卡出口)', () => {
  it('drops lines containing a corrected sentence (whitespace-normalised) and counts them', () => {
    const r = dropCorrectedLines('他喜欢爬山\n他住在 杭州西湖区,常去湖边\n养了一只猫', ['住在 杭州西湖区'])
    expect(r).toEqual({ text: '他喜欢爬山\n养了一只猫', dropped: 1 })
  })
  it(`ignores corrected sentences shorter than ${MIN_CORRECTED_CHARS} chars (a short word would blank unrelated lines)`, () => {
    expect(dropCorrectedLines('他喜欢猫\n猫很好', ['猫']).dropped).toBe(0)
  })
  it('KNOWN LIMIT: a paraphrase gets through — this filter is verbatim only', () => {
    expect(dropCorrectedLines('他家在西湖附近', ['住在 杭州西湖区']).dropped).toBe(0)
  })
  it('structured output: hit strings are removed from arrays and blanked in objects', () => {
    const r = dropCorrectedValues({ title: '画像', cards: [{ title: '住处', body: '住在 杭州西湖区' }], tags: ['爱爬山', '住在 杭州西湖区的老房子'] }, ['住在 杭州西湖区'])
    expect(r.value).toEqual({ title: '画像', cards: [{ title: '住处', body: '' }], tags: ['爱爬山'] })
    expect(r.dropped).toBe(2)
  })
  it('records a running count per chat', () => {
    const d = fresh()
    recordRedactions(d, 'overview', 2, '2026-10-23T00:00:00Z')
    recordRedactions(d, 'profile', 1, '2026-10-23T01:00:00Z')
    expect(JSON.parse(readFileSync(join(d, 'memory-redactions.json'), 'utf8'))).toEqual({ total: 3, byKind: { overview: 2, profile: 1 }, last: '2026-10-23T01:00:00Z' })
  })
})

describe('purgeCorrectedFromSources (清源头)', () => {
  it('removes matching lines from profile / preferences / notes, snapshots each changed file first, and reports what it removed', () => {
    const d = fresh(), archive = join(d, 'archive')
    mkdirSync(join(d, 'notes', 'trips'), { recursive: true })
    writeFileSync(join(d, 'profile.md'), '- 住在 杭州西湖区\n- 喜欢爬山\n')
    writeFileSync(join(d, 'preferences.md'), '- 咖啡不加糖\n')
    writeFileSync(join(d, 'notes', 'trips', 'home.md'), '老家:住在杭州西湖区(旧)\n住在  杭州西湖区\n')
    const removed = purgeCorrectedFromSources(d, '住在 杭州西湖区', archive, '2026-10-23-1')
    expect(removed).toEqual([{ file: 'profile.md', lines: 1 }, { file: 'notes/trips/home.md', lines: 1 }])
    expect(readFileSync(join(d, 'profile.md'), 'utf8')).toBe('- 喜欢爬山\n')
    expect(readFileSync(join(d, 'preferences.md'), 'utf8')).toBe('- 咖啡不加糖\n')
    expect(readFileSync(join(d, 'notes', 'trips', 'home.md'), 'utf8')).toBe('老家:住在杭州西湖区(旧)\n')
    expect(readdirSync(archive).sort()).toEqual(['notes__trips__home.md.2026-10-23-1.md', 'profile.md.2026-10-23-1.md'])
    expect(readFileSync(join(archive, 'profile.md.2026-10-23-1.md'), 'utf8')).toBe('- 住在 杭州西湖区\n- 喜欢爬山\n')
  })
  it('does nothing for a corrected sentence below the length floor', () => {
    const d = fresh()
    writeFileSync(join(d, 'profile.md'), '- 猫\n')
    expect(purgeCorrectedFromSources(d, '猫', join(d, 'a'), 's')).toEqual([])
    expect(existsSync(join(d, 'a'))).toBe(false)
  })
})
