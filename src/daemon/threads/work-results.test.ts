import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { readWorkResults, readMatterConclusion, isScratchMatter, SETTLE_MS } from './work-results'

const T0 = Date.UTC(2026, 10, 1)
function seed() {
  const db = openTestDb()
  let cursor = 0
  const matter = (id: string, kind: string, title: string, path: string | null, state = 'open') =>
    db.query(`INSERT INTO matters(id, kind, title, project_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, kind, title, path, state, T0, T0)
  const seqs = new Map<string, number>()
  const item = (m: string, kind: 'user_message' | 'agent_message' | 'tool_call', text: string, at: number) => {
    const seq = (seqs.get(m) ?? 0) + 1; seqs.set(m, seq); cursor++
    db.query(`INSERT INTO matter_items(matter_id, seq, kind, status, payload_json, created_at, updated_at, cursor) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`)
      .run(m, seq, kind, JSON.stringify({ text }), at, at, cursor)
    return cursor
  }
  return { db, matter, item }
}

describe('readWorkResults (话题 T1:agent 的活只取结论)', () => {
  it('直接结论写回也排除自检和临时事项,保留主人修复升级的真实结论', () => {
    const { db, matter, item } = seed()
    try {
      matter('self', 'task', 'selftest workbench', '/Users/o/cc', 'done')
      matter('scratch', 'task', '演练', '/private/tmp/probe', 'done')
      matter('real', 'task', '修复自动升级', '/Users/o/cc', 'done')
      item('self', 'agent_message', '自检已过', T0)
      item('scratch', 'agent_message', '演练完成', T0)
      item('real', 'user_message', '修复自动升级的回滚漏洞', T0)
      item('real', 'agent_message', '回滚漏洞已修复,补了失败版本的回归测试', T0)
      expect(readMatterConclusion(db, 'self', 0)).toBeNull()
      expect(readMatterConclusion(db, 'scratch', 0)).toBeNull()
      expect(readMatterConclusion(db, 'real', 0)?.result).toContain('回滚漏洞已修复')
    } finally { db.close() }
  })
  it('旧升级回执不进工作结论,水位照样越过机器事务', () => {
    const { db, matter, item } = seed()
    try {
      matter('receipt', 'terminal', 'wechat-cc', '/Users/o/cc', 'done')
      const cursor = item('receipt', 'agent_message', 'Codex升至0.167.0自检过', T0)
      expect(readWorkResults(db, 0, T0)).toEqual({ results: [], nextCursor: cursor })
      expect(readMatterConclusion(db, 'receipt', 0)).toBeNull()
    } finally { db.close() }
  })
  it('selftest 功能开发的主人事项不是机器自检', () => {
    const { db, matter, item } = seed()
    try {
      matter('real', 'task', 'selftest 手机验收的回滚漏洞修复', '/Users/o/cc', 'done')
      item('real', 'user_message', '修复自检回滚漏洞', T0)
      item('real', 'agent_message', '已修复自检回滚漏洞,决定保留新版验收入口', T0)
      expect(readMatterConclusion(db, 'real', 0)?.result).toContain('已修复')
      expect(readWorkResults(db, 0, T0).results.map(r => r.matterId)).toEqual(['real'])
    } finally { db.close() }
  })
  it('每段只取最后那条 agent 回话;过程不要;自检 / 临时目录跳过', () => {
    const { db, matter, item } = seed()
    matter('t1', 'terminal', 'bx', '/Users/o/Documents/bx', 'done')
    matter('s1', 'task', 'selftest', '/Users/o/x', 'done')
    matter('s2', 'task', '读 DATA.md', '/private/tmp/claude-501/x/project-b', 'done')
    matter('c1', 'chat', '聊天', null)
    item('t1', 'user_message', '修 DNS', T0)
    item('t1', 'agent_message', '先看看', T0 + 1)
    item('t1', 'tool_call', 'dig', T0 + 2)
    const last = item('t1', 'agent_message', '修好了:改 resolv 顺序', T0 + 3)
    item('t1', 'user_message', '再看下 v6', T0 + 4)
    const v6 = item('t1', 'agent_message', 'v6 也通', T0 + 5)
    item('s1', 'agent_message', 'selftest ok', T0)
    item('s2', 'agent_message', 'KIMI', T0)
    const r = readWorkResults(db, 0, T0 + 10)
    expect(r.results.map(x => [x.matterId, x.ask, x.result, x.cursor, x.project])).toEqual([
      ['t1', '修 DNS', '修好了:改 resolv 顺序', last, 'bx'],
      ['t1', '再看下 v6', 'v6 也通', v6, 'bx'],
    ])
    expect(r.nextCursor).toBe(8)   // 只看主人的话和 agent 回话的 cursor
    expect(readWorkResults(db, r.nextCursor, T0 + 10).results).toEqual([])
  })

  it('没做完的段不交;水位停在它前面;过了 SETTLE_MS 才算做完', () => {
    const { db, matter, item } = seed()
    matter('t1', 'terminal', 'bx', '/Users/o/bx')
    matter('t2', 'task', 'writter', '/Users/o/writter', 'done')
    const ask = item('t1', 'user_message', '修 DNS', T0)
    item('t1', 'agent_message', '在跑', T0 + 1)
    item('t2', 'agent_message', '写完了', T0 + 2)
    const early = readWorkResults(db, 0, T0 + 1000)
    expect(early.results.map(x => x.result)).toEqual([])   // t2 的 cursor 在 t1 那段之后 ⇒ 一起等
    expect(early.nextCursor).toBe(ask - 1)
    const later = readWorkResults(db, 0, T0 + SETTLE_MS + 10)
    expect(later.results.map(x => x.result)).toEqual(['在跑', '写完了'])
    expect(later.nextCursor).toBe(3)
  })

  it('要求在水位之前、结论在水位之后:要求照样带上', () => {
    const { db, matter, item } = seed()
    matter('t1', 'terminal', 'bx', '/Users/o/bx', 'done')
    const ask = item('t1', 'user_message', '修 DNS', T0)
    item('t1', 'agent_message', '好了', T0 + 1)
    expect(readWorkResults(db, ask, T0 + 5).results).toMatchObject([{ ask: '修 DNS', result: '好了' }])
  })

  it('isScratchMatter', () => {
    expect(isScratchMatter('selftest-phone', '/Users/o/x')).toBe(true)
    expect(isScratchMatter('x', '/var/folders/yc/T/wechat-cc-selftest/wb')).toBe(true)
    expect(isScratchMatter('x', 'C:\\Users\\o\\AppData\\Local\\Temp\\p')).toBe(true)
    expect(isScratchMatter('bx', '/Users/o/Documents/bx')).toBe(false)
    expect(isScratchMatter('聊天', null)).toBe(false)
  })
})
