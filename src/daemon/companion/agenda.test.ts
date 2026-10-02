import { describe, it, expect } from 'vitest'
import { parseAgenda, selectDue, markResolved, unmarkResolved } from './agenda'

const SAMPLE = `# agenda（我给自己记的待跟进）
- [ ] due:2026-05-14 面试后轻轻问结果/感受
- [ ] due:2026-06-01 重构排产模块后问推进
- [x] done:2026-05-02 上次的部署问过了
随便一行 prose，应该被忽略
- [ ] 没有 due 的行也忽略`

describe('parseAgenda', () => {
  it('parses pending and resolved items, ignores prose and due-less lines', () => {
    const items = parseAgenda(SAMPLE)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ status: 'pending', due: '2026-05-14', body: '面试后轻轻问结果/感受' })
    expect(items[1]).toMatchObject({ status: 'pending', due: '2026-06-01' })
    expect(items[2]).toMatchObject({ status: 'resolved', due: null })
  })

  it('recognizes fired/dropped as resolved (forward-compat)', () => {
    const items = parseAgenda('- [x] fired:2026-05-10 a\n- [x] dropped:2026-05-11 b')
    expect(items.map(i => i.status)).toEqual(['resolved', 'resolved'])
  })

  it('returns [] for empty input', () => {
    expect(parseAgenda('')).toEqual([])
  })

  it('tolerates CRLF line endings', () => {
    const items = parseAgenda('- [ ] due:2026-05-14 面试后问\r\n- [ ] due:2026-06-01 重构后问\r\n')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ status: 'pending', due: '2026-05-14', body: '面试后问' })
  })
})

describe('selectDue', () => {
  it('returns pending items whose due is on or before today', () => {
    const due = selectDue(parseAgenda(SAMPLE), '2026-05-20')
    expect(due).toHaveLength(1)
    expect(due[0]!.due).toBe('2026-05-14')
  })

  it('excludes future-due and already-resolved items', () => {
    const due = selectDue(parseAgenda(SAMPLE), '2026-05-14')
    expect(due.map(i => i.due)).toEqual(['2026-05-14'])
    const none = selectDue(parseAgenda(SAMPLE), '2026-05-13')
    expect(none).toEqual([])
  })
})

describe('markResolved', () => {
  it('rewrites the matching pending line to done, leaving others intact', () => {
    const items = parseAgenda(SAMPLE)
    const out = markResolved(SAMPLE, items[0]!, '2026-05-20')
    expect(out).toContain('- [x] done:2026-05-20 面试后轻轻问结果/感受')
    expect(out).not.toContain('- [ ] due:2026-05-14')
    expect(out).toContain('- [ ] due:2026-06-01 重构排产模块后问推进')
  })

  it('is a no-op when the item line is no longer present', () => {
    const items = parseAgenda(SAMPLE)
    const stale = { ...items[0]!, raw: '- [ ] due:1999-01-01 not in file' }
    expect(markResolved(SAMPLE, stale, '2026-05-20')).toBe(SAMPLE)
  })

  it('resolves the matching line on a CRLF file', () => {
    const crlf = '- [ ] due:2026-05-14 面试后问\r\n- [ ] due:2026-06-01 重构后问\r\n'
    const item = parseAgenda(crlf)[0]!
    const out = markResolved(crlf, item, '2026-05-20')
    expect(out).toContain('- [x] done:2026-05-20 面试后问')
    expect(out).not.toContain('- [ ] due:2026-05-14')
  })
})

// 第二轮评审 #194 P2:撤回只把本次打勾的那一行放回去,保留文件里后来的改动。
describe('unmarkResolved (review #194)', () => {
  it('puts back only the line we resolved; other edits made meanwhile survive', () => {
    const md = '- [ ] due:2026-05-13 ping me about the gym\n- [ ] due:2026-06-01 other'
    const item = parseAgenda(md)[0]!
    const resolved = markResolved(md, item, '2026-05-13')
    const edited = resolved + '\n- [ ] due:2026-07-01 added meanwhile'
    expect(unmarkResolved(edited, item, '2026-05-13')).toBe(md + '\n- [ ] due:2026-07-01 added meanwhile')
  })
  it('our line is gone or changed → leave the file alone', () => {
    const md = '- [ ] due:2026-05-13 ping'
    const item = parseAgenda(md)[0]!
    expect(unmarkResolved('- [x] done:2026-05-13 ping (edited)', item, '2026-05-13')).toBe('- [x] done:2026-05-13 ping (edited)')
  })
})
