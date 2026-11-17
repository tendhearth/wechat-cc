import {makeMatterLedger} from '../../adapters/store/matter-ledger'
import { afterEach, expect, it } from 'vitest'
import { openTestDb, type Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { topicRoutes } from './topic-routes'
import { consoleRoutes } from '../console/routes'
import type { RouteHandler } from '../../daemon/internal-api/types'
const dbs: Db[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
it.each(['other-admin', 'owner', 'operator'] as const)('caller provenance: %s receives only authorized work and private topics', async who => {
  const db = openTestDb(); dbs.push(db)
  const raw = makeThreadsStore(db), matters = makeMatterStore(db), log = makeMatterLog(db)
  const m = matters.create({ kind: 'task', title: 'bx', ownerChatId: 'owner', projectPath: '/projects/bx' })
  log.startTurn({ matterId: m.id, executor: 'codex', policy: { cwd: '/projects/bx' } })
  const topic = async (title: string, priv: boolean, work: boolean) => {
    const id = await raw.create({ chatId: 'owner', title, summary: title, facets: ['task'], tags: [], private: priv, episodes: [] })
    await raw.addEntry({ threadId: id, kind: 'conclusion', line: title, body: `${title}_BODY`, source: work ? 'work' : 'chat', matterId: work ? m.id : null })
    return id
  }
  const ledger=makeMatterLedger(db);ledger.start(m.id,'caller-ledger','codex','work');ledger.note(m.id,'caller-ledger','codex','LEDGER_CALLER_CANARY')
  const publicWork = await topic('OWNER_WORK_CONCLUSION', false, true), privateId = await topic('PRIVATE_CANARY', true, true)
  await topic('CHAT_CANARY', false, false)
  await raw.addEntry({threadId:publicWork,kind:'conclusion',line:'LEDGER_CALLER_CANARY',body:ledger.notes(m.id).at(-1)!.text,source:'work',matterId:m.id})
  const caller: Parameters<RouteHandler>[2] = who === 'operator' ? { tier: 'admin', origin: 'operator' } : { tier: 'admin', origin: 'session', chatId: who }
  const search = topicRoutes({ db, ownerChatId: () => 'owner' })['POST /v1/memory/topics/search']!
  const results = await search(new URLSearchParams(), { query: 'OWNER_WORK_CONCLUSION PRIVATE_CANARY CHAT_CANARY LEDGER_CALLER_CANARY', limit: 5 }, caller)
  const text = JSON.stringify(results.body)
  expect(text.includes('LEDGER_CALLER_CANARY')).toBe(who !== 'other-admin')
  expect(text.includes('CHAT_CANARY')).toBe(true)
  expect(text.includes('OWNER_WORK_CONCLUSION')).toBe(who !== 'other-admin')
  expect(text.includes('PRIVATE_CANARY')).toBe(who !== 'other-admin')
  const routes = consoleRoutes({ db, stateDir: '/unused-caller-test', conversationStore: makeConversationStore(db), ownerChatId: () => 'owner' })
  const listed = await routes['GET /v1/dialogue/threads']!(new URLSearchParams({ chat_id: 'owner', include_private: '1' }), null, caller)
  expect(JSON.stringify(listed.body).includes('OWNER_WORK_CONCLUSION')).toBe(who !== 'other-admin')
  expect(JSON.stringify(listed.body).includes('PRIVATE_CANARY')).toBe(who !== 'other-admin')
  for (const id of [publicWork, privateId]) {
    const detail = await routes['GET /v1/dialogue/thread']!(new URLSearchParams({ id }), null, caller)
    expect(detail.status).toBe(who === 'other-admin' ? 404 : 200)
  }
})
