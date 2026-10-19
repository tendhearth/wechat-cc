import { describe, it, expect } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import type { CliSessionRowT } from '../backend/types'
import { canSayTo, relAgo, terminalErrorKey, terminalNeedsYou, terminalRow, terminalRows } from './terminal'
import { mapPhoneError } from '../net/errors'

const NOW = 10_000_000
const row = (over: Partial<CliSessionRowT> = {}): CliSessionRowT => ({
  session_id: 's1', code: 's1', source: 'claude', status: 'idle', stale: false, project: 'blog', machine: null,
  last_summary: 'done', last_event_at: NOW - 5 * 60_000, last_prompt_at: null, created_at: 1, pending: null, ...over,
})
const waiting = (actionable: boolean, over: Partial<CliSessionRowT> = {}) => row({
  status: 'waiting', pending: { tool: 'Bash', summary: 'npm run deploy', since: NOW, hash: actionable ? 'ab12c' : null, actionable }, ...over,
})

describe('终端里的会话(手机视图)', () => {
  it('夹具本身过真 schema(含 pending.hash / actionable)', () => {
    expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse({ ok: true, sessions: [row(), waiting(true), waiting(false)] }).success).toBe(true)
  })
  it('一行:项目、哪家、多久前、等批准的那一项;只有中继开了码的才能拍', () => {
    expect(terminalRow(row({ source: 'codex' }), NOW, 'zh-Hans')).toMatchObject({ project: 'blog', source: 'Codex', agent: 'codex', status: 'idle', ago: '5 分钟前', pendingText: null, actionable: false })
    expect(terminalRow(row({ source: 'cursor' }), NOW, 'zh-Hans')).toMatchObject({ source: 'Cursor', agent: 'cursor' })
    expect(terminalRow(waiting(true), NOW, 'en')).toMatchObject({ pendingText: 'Bash: npm run deploy', actionable: true, hash: 'ab12c', source: 'Claude Code' })
    expect(terminalRow(waiting(false), NOW, 'en').actionable).toBe(false)
    // 老 daemon:pending 不带 hash / actionable ⇒ 不可拍
    expect(terminalRow(row({ status: 'waiting', pending: { tool: 'Bash', summary: null, since: 1 } }), NOW, 'en')).toMatchObject({ pendingText: 'Bash', actionable: false })
  })
  it('列表:结束了的不列;等你批准的在前,其余按最近动静', () => {
    const v = terminalRows([row({ session_id: 'old', last_event_at: 1 }), row({ session_id: 'end', status: 'ended' }), waiting(false, { session_id: 'w', last_event_at: 0 }), row({ session_id: 'new', last_event_at: NOW })], NOW, 'en')
    expect(v.map(r => r.id)).toEqual(['w', 'new', 'old'])
    expect(terminalRows(undefined, NOW, 'en')).toEqual([])
  })
  it('「此刻」的数:只算手机拍得了的;够不着电脑 ⇒ 0', () => {
    const list = [waiting(true, { session_id: 'a' }), waiting(false, { session_id: 'b' }), row({ session_id: 'c' })]
    expect(terminalNeedsYou(list, true).map(s => s.session_id)).toEqual(['a'])
    expect(terminalNeedsYou(list, false)).toEqual([])
  })
  it('只有歇着的能接着说', () => {
    expect(canSayTo('idle')).toBe(true)
    for (const s of ['running', 'waiting', 'ended', undefined] as const) expect(canSayTo(s)).toBe(false)
    // 开在电脑窗口里:在跑也能说(送进窗口);等批准仍要先拍板
    expect(canSayTo('running', true)).toBe(true)
    expect(canSayTo('idle', true)).toBe(true)
    expect(canSayTo('waiting', true)).toBe(false)
    expect(canSayTo(undefined, true)).toBe(false)
  })
  it('多久前:刚刚 / 分钟 / 小时 / 日期', () => {
    expect(relAgo(NOW - 10_000, NOW, 'en')).toBe('just now')
    expect(relAgo(NOW - 2 * 3_600_000, NOW, 'en')).toBe('2 h ago')
    expect(relAgo(NOW - 3 * 86_400_000, NOW, 'en')).toMatch(/\d+\/\d+ \d\d:\d\d/)
  })
  it('daemon 的错误码 ⇒ 一句话(经 mapPhoneError)', () => {
    const say = (status: number, error: string) => terminalErrorKey(mapPhoneError(status, { ok: false, error })!)
    expect(say(409, 'cli_session_busy')).toBe('terminal.sayBusy')
    expect(say(409, 'cli_session_ended')).toBe('terminal.sayEnded')
    expect(say(409, 'cli_session_remote')).toBe('terminal.remote')
    expect(say(409, 'cli_permission_stale')).toBe('terminal.stale')
    expect(say(409, 'cli_not_actionable')).toBe('terminal.askedLocally')
    expect(say(404, 'not_found')).toBe('terminal.gone')
    expect(mapPhoneError(503, { ok: false, error: 'cli_actions_not_wired' })).toBe('unavailable')
    expect(terminalErrorKey('uncertain')).toBe('terminal.uncertain')
    expect(terminalErrorKey('offline')).toBe('terminal.failed')
  })
  it('在跑的会话带 now ⇒ nowText 按界面语言拼;不在跑 / 认不出的 verb 退回原文', () => {
    const now = { kind: 'step' as const, text: '运行 npm test', at: NOW, verb: 'run', target: 'npm test' }
    expect(terminalRow(row({ status: 'running', now }), NOW, 'en').nowText).toBe('Run npm test')
    expect(terminalRow(row({ status: 'running', now }), NOW, 'zh-Hans').nowText).toBe('运行 npm test')
    expect(terminalRow(row({ status: 'running', now: { ...now, verb: 'teleport' } }), NOW, 'en').nowText).toBe('运行 npm test')
    expect(terminalRow(row({ status: 'idle', now }), NOW, 'en').nowText).toBeNull()
  })
})
