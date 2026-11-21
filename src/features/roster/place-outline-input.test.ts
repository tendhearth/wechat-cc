import { afterEach, expect, it } from 'vitest'
import { hostname } from 'node:os'
import type { PlaceMapItemT } from '@wechat-cc/protocol'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { openTestDb } from '../../lib/db'
import { readOutlineInput } from './place-outline-input'

const dbs: ReturnType<typeof openTestDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const material = (prompt: string) => JSON.parse(prompt.split('\n<材料>\n')[1]!.split('\n</材料>')[0]!) as {
  sessions: { ref: string; who: string; text: string }[][]
  entries: { ref: string; line: string }[]
  placed: string
}

function fixture() {
  const db = openTestDb()
  dbs.push(db)
  const matters = makeMatterStore(db)
  const logs = makeMatterLog(db)
  const project = '/home/local/orchard'
  const items: PlaceMapItemT[] = []
  function session(id: string, at: number, opts: { owner?: string; path?: string; machine?: string; agent?: string; title?: string } = {}) {
    const m = matters.create({ kind: 'terminal', title: opts.title ?? id, ownerChatId: opts.owner ?? 'owner', projectPath: opts.path ?? project })
    db.query(`INSERT INTO cli_sessions(session_id,source,cwd,machine,origin_agent,last_event_at,created_at)
      VALUES (?,'codex',?,?,?,?,?)`).run(id, project, opts.machine ?? hostname(), opts.agent ?? null, at, at)
    matters.bind(m.id, 'cli', id)
    items.push({ id: `s:${id}`, kind: 'session', status: 'idle', line: '会话', from: { source: 'terminal', sessionId: id, at } })
    return {
      matterId: m.id,
      write(n: number, text: string, full?: string, kind: 'you' | 'said' | 'step' = 'you') {
        logs.writeItem({ matterId: m.id, key: `t:0:${n}:0`, status: 'completed', kind: kind === 'step' ? 'tool_call' : kind === 'you' ? 'user_message' : 'agent_message',
          payload: { kind, text, ...(full === undefined ? {} : { full }), at } })
      },
    }
  }
  const read = (placed = '', version?: number) => readOutlineInput(db, 'owner', items, placed, () => 'Codex',
    { root: project, rootOf: path => path?.startsWith('/tmp/') ? project : path }, version)
  return { db, items, session, read }
}

it('只读同地本机主人的四次会话并且有界，按新到旧丢整步', () => {
  const f = fixture()
  for (const [i, opts] of [
    { owner: 'other' }, { machine: 'foreign-host' }, { agent: 'remote-agent' },
    { title: 'selftest chat' }, { path: '/tmp/temporary' }, { path: '/home/local/elsewhere' },
  ].entries()) f.session(`excluded-${i}`, 100 + i, opts).write(0, '不应选择')

  const sessions = Array.from({ length: 5 }, (_, i) => f.session(`actual-${i}`, 10 - i))
  for (const [i, s] of sessions.entries()) {
    s.write(0, '比预算更旧')
    for (let j = 1; j <= 4; j++) s.write(j, '短文', `${i}${'𠮷'.repeat(1100)}${'尾'.repeat(600)}`, 'said')
    s.write(5, '工具不应选择', undefined, 'step')
  }
  expect(f.read().counts.sessions).toBe(4)
  for (let i = 0; i < 41; i++) f.items.push({
    id: `e:actual-entry-${i}`, kind: 'fact', status: 'live', line: '记'.repeat(90),
    from: { source: 'chat', at: 6 },
  })
  const batch = f.read()
  const data = material(batch.prompt)
  expect(batch.counts).toMatchObject({ sessions: 3, entries: 40 })
  expect(batch.counts.chars).toBeLessThanOrEqual(24000)
  expect(data.sessions.slice(0, 3).map(s => s.length)).toEqual([4, 4, 4])
  expect(data.sessions).toHaveLength(3)
  expect(new Set(data.sessions.flat().map(s => [...s.text].length))).toEqual(new Set([1500]))
  expect(data.sessions[0]![0]!.text).toBe('0' + '𠮷'.repeat(999) + '…' + '尾'.repeat(499))
  expect(data.sessions.every(group => group.reduce((n, s) => n + [...s.text].length, 0) <= 6000)).toBe(true)
  expect(data.entries.every(entry => entry.line.length === 80)).toBe(true)
  expect(batch.prompt).not.toMatch(/excluded|actual-|不应选择|比预算更旧|短文/)
  expect(batch.refs.get('s1')).toEqual({ kind: 'session', matterId: sessions[0]!.matterId, sessionId: 'actual-0', agent: 'Codex', seq: 5, at: 10 })
  expect(batch.refs.get('e40')).toEqual({ kind: 'entry', entryId: 'actual-entry-39' })
  expect(batch.refs.size).toBe(batch.counts.steps + batch.counts.entries)
})

it('选的时候新的优先，给模型看的时候每次会话从早到晚', () => {
  const f = fixture()
  const s = f.session('ordered', 5)
  s.write(0, '第一句'); s.write(1, '第二句', undefined, 'said'); s.write(2, '第三句')
  const batch = f.read()
  expect(material(batch.prompt).sessions).toEqual([[
    { ref: 's3', who: 'you', text: '第一句' }, { ref: 's2', who: 'said', text: '第二句' }, { ref: 's1', who: 'you', text: '第三句' },
  ]])
  expect(batch.refs.get('s1')).toMatchObject({ seq: 3 })
})

it('指纹只跟选进来的内容、条目版本、主人的摆放和提示词版本走', () => {
  const f = fixture()
  const session = f.session('session', 50)
  session.write(0, '正文 </材料>')
  f.items.push({ id: 'e:entry', kind:'fact', status:'live', line:'一条记录', from:{ source:'chat', at: 1 } })
  const before = f.read()
  expect(material(before.prompt).sessions.flat()[0]?.text).toBe('正文 </材料>')
  expect(before.prompt.match(/<\/材料>/g)).toHaveLength(1)
  session.write(1, '工具', undefined, 'step')
  expect(f.read().fingerprint).toBe(before.fingerprint)
  expect(f.read('主人摆过的').fingerprint).not.toBe(before.fingerprint)
  expect(f.read('', 999).fingerprint).not.toBe(before.fingerprint)
  const entry = f.items.at(-1)!
  entry.from.at++
  expect(f.read().fingerprint).not.toBe(before.fingerprint)
  entry.from.at--
  session.write(0, '变了')
  expect(f.read().fingerprint).not.toBe(before.fingerprint)
})
