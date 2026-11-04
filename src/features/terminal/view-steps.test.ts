import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalStepStore } from '../../adapters/store/terminal-steps'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { renderTranscriptTail } from '../../domain/cli-transcript'
import type { CliSessionInfo, CliSource } from '../../app/cli-events'
import type { TerminalStepPayload } from '../../ports/terminal-steps'
import { renderTurnSteps, VIEW_STEPS_MAX } from './cli-activity'
import { parseAll } from './activity.fixture'
import { makeTerminalSteps, type TerminalSteps } from './terminal-steps'
import { makeCliReplyCore, readTail } from './reply-handler'

/**
 * 微信「看 码」的「这一轮做了什么」(M6d):从这件事的步读,不再每次整段重解析记录。
 * 对照 = M6d 以前的那一份(整段解析 200 条 → 主人最后一句之后的步),逐字照抄在这里:同一份数据,页面一字不差。
 */
function oldRenderTurnSteps(jsonl: string, source: CliSource): string {
  const items = parseAll(jsonl, source, 200)
  let from = 0
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'you') { from = i + 1; break }
  const steps = items.slice(from).filter(i => i.kind === 'step')
  if (!steps.length) return ''
  const shown = steps.slice(-VIEW_STEPS_MAX)
  const lines = ['## 这一轮做了什么', '']
  if (steps.length > shown.length) lines.push(`_(共 ${steps.length} 步,只列最后 ${shown.length} 步)_`, '')
  for (const s of shown) lines.push(`- ${s.text.replace(/\n/g, ' ')}${s.error ? '(没成)' : ''}`)
  return lines.join('\n') + '\n'
}

const L = (o: object) => JSON.stringify(o)
const T = '2026-11-04T10:00:00.000Z'
const tool = (id: string, name: string, input: object) => L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string, isError = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })

/** 两轮:上一轮做过的不该出现;这一轮 13 步(超过 12 ⇒ 只列最后 12)、一串「读 x」合并、报错标「没成」、密钥打码、多行命令。 */
const CLAUDE_TWO_TURNS = [
  L({ type: 'user', timestamp: T, message: { content: '上一件事' } }),
  tool('o1', 'Read', { file_path: '/p/old.ts' }), result('o1', 'x'),
  L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '上一件做完了' }] } }),
  L({ type: 'user', timestamp: T, message: { content: '把测试修好' } }),
  tool('r1', 'Read', { file_path: '/p/a.ts' }), tool('r2', 'Read', { file_path: '/p/a.ts' }), result('r1', 'a'), result('r2', 'a'),
  tool('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'SECRET_OLD', new_string: 'y' }), result('e1', 'ok'),
  tool('b1', 'Bash', { command: 'npm test\necho TOKEN=abcd1234zz' }), result('b1', '1 failed', true),
  ...Array.from({ length: 9 }, (_, i) => [tool(`s${i}`, 'Bash', { command: `step${i}` }), result(`s${i}`, 'ok')]).flat(),
  tool('g1', 'Grep', { pattern: 'TODO' }),
  L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '改好了' }] } }),
].join('\n') + '\n'

const CODEX = [
  L({ type: 'response_item', timestamp: T, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下 lint' }] } }),
  L({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'bun run lint'] }) } }),
  L({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Script failed\nOutput:\n{"output":"2 errors","exit_code":1}' } }),
  L({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n-x\n+y\n*** End Patch' } }),
].join('\n') + '\n'

let db: Db, dir: string
beforeEach(() => { db = openDb({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'view-steps-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const stepsOf = (): TerminalSteps => {
  const log = makeMatterLog(db), matters = makeMatterStore(db)
  return makeTerminalSteps({ store: makeTerminalStepStore({ db, log, matters }), turns: makeTerminalTurnLog({ db, log, matters }) })
}
const session = (path: string, source: CliSource = 'claude'): CliSessionInfo => ({ session_id: `S-${source}`, source, cwd: '/w/blog', transcript_path: path, machine: 'mac', lastSeenAt: 1 })

describe('「看 码」这一轮做了什么:从步读(M6d)', () => {
  it.each([['claude', CLAUDE_TWO_TURNS], ['codex', CODEX]] as const)('%s:同一份记录,从步渲染的和以前整段解析渲染的一字不差', (source, jsonl) => {
    const path = join(dir, `${source}.jsonl`)
    writeFileSync(path, jsonl)
    const items: TerminalStepPayload[] = stepsOf().view(session(path, source), 200)
    const want = oldRenderTurnSteps(jsonl, source)
    expect(want).not.toBe('')
    expect(renderTurnSteps(items)).toBe(want)
  })

  it('claude 那份的样子钉一下(只列这一轮、最后 12 步、没成、打码、不放 diff)', () => {
    const md = oldRenderTurnSteps(CLAUDE_TWO_TURNS, 'claude')
    expect(md).toContain('_(共 13 步,只列最后 12 步)_')
    expect(md).toContain('- 运行 npm test …(没成)')
    expect(md).toContain('- 搜「TODO」')
    expect(md).not.toContain('old.ts'); expect(md).not.toContain('SECRET_OLD')
  })

  it('记录分几次长出来(每次「看」读新增的那一段)⇒ 每一次都和那一刻整段解析的一样', () => {
    const path = join(dir, 'grow.jsonl')
    const lines = CLAUDE_TWO_TURNS.split('\n').filter(Boolean)
    const steps = stepsOf()
    writeFileSync(path, '')
    let acc = ''
    for (const line of lines) {
      appendFileSync(path, line + '\n'); acc += line + '\n'
      expect(renderTurnSteps(steps.view(session(path), 200))).toBe(oldRenderTurnSteps(acc, 'claude'))
    }
  })

  it('makeCliReplyCore.viewMarkdown 接了步 ⇒ 整页(对话尾巴 + 这一轮)和以前一字不差;第一次看建那件事', () => {
    const path = join(dir, 'page.jsonl')
    writeFileSync(path, CLAUDE_TWO_TURNS)
    const s = session(path)
    const matters = makeMatterStore(db)
    const core = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s] }, log: () => {}, dangerously: false, steps: stepsOf() })
    expect(matters.findBySurface('cli', s.session_id)).toBeNull()
    const v = core.viewMarkdown(s, '标题')
    const jsonl = readTail(path)
    const old = oldRenderTurnSteps(jsonl, 'claude')
    expect(v).toEqual({ ok: true, markdown: renderTranscriptTail(jsonl, 'claude', { title: '标题' }) + `\n${old}` })
    expect(matters.findBySurface('cli', s.session_id)).toMatchObject({ kind: 'terminal' })
  })

  it('不再整段解析记录:步里没有的,页面上就没有(步是空的 ⇒ 不带这一段)', () => {
    const path = join(dir, 'empty-steps.jsonl')
    writeFileSync(path, CLAUDE_TWO_TURNS)
    const s = session(path)
    const asked: number[] = []
    const core = makeCliReplyCore({ hub: { lookup: () => s, sessions: () => [s] }, log: () => {}, dangerously: false, steps: { view: (_s, max) => { asked.push(max); return [] } } })
    const v = core.viewMarkdown(s, '标题') as { ok: true; markdown: string }
    expect(v.markdown).toBe(renderTranscriptTail(readTail(path), 'claude', { title: '标题' }))
    expect(v.markdown).not.toContain('这一轮做了什么')
    expect(asked).toEqual([200])
  })
})
