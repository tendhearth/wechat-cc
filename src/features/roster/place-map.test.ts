import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PlaceMapResponse } from '@wechat-cc/protocol'
import { createInternalApi } from '../../daemon/internal-api'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makePlacesStore } from '../../adapters/store/places-store'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeProjectTopicResolver } from '../terminal/project-memory'
import { makePlacesReader, placeKey } from './places-reader'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const owner = 'map-owner'
const now = Date.UTC(2026, 10, 21)

function fixture() {
  // Use a real .git/commondir outside system temp: provenance excludes scratch work.
  const base = mkdtempSync(resolve('.place-map-test-'))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(realpathSync(base), 'melon')
  const gitDir = join(repo, '.git', 'worktrees', 'other')
  const worktree = join(base, 'worktree')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'commondir'), '../..\n')
  writeFileSync(join(gitDir, 'gitdir'), join(worktree, '.git') + '\n')

  const db = openTestDb()
  cleanups.push(() => db.close())
  const matters = makeMatterStore(db, () => now)
  const threads = makeThreadsStore(db)
  const store = makePlacesStore(db)
  const task = (projectPath: string, ownerChatId = owner) => matters.create({ kind:'task', title:'交办的任务', projectPath, ownerChatId })
  const topic = (title: string, privateTopic = false, chatId = owner) =>
    threads.create({ chatId, title, private:privateTopic, summary:'', facets:[], tags:[], episodes:[] })
  const reader = makePlacesReader({
    store, mapTopics: { db, owner: () => owner,
      makeResolver: (db, owner, topics, roots) => makeProjectTopicResolver(db, owner, topics, undefined, roots, { includeDoneHistory:true }),
    },
    roster: { matters, seen: () => null, now: () => now, terminals: () => [
      { session_id:'ask-session', code:'ask', project:repo, source:'codex', status:'waiting',
        last_event_at:now, last_summary:'要继续吗', pending:{tool:'Read',summary:'要继续吗',since:now},
        cwd:repo, stale:false, machine:null, origin_agent:null, last_prompt_at:null, created_at:now },
    ] },
  })
  return { db, store, reader, key: placeKey(repo), repo, worktree, task, topic, threads }
}

it('真实迁移库按事项和聊天证据归地方，工作区归主仓，拒绝其他所有者、私有话题和 superseded，不写地方表', async () => {
  const f = fixture()
  const task = f.task(f.worktree)
  const threadId = await f.topic('melon')
  const add = (line: string, input: Partial<Parameters<typeof f.threads.addEntry>[0]> = {}) =>
    f.threads.addEntry({ threadId, line, kind:'fact', source:'chat', ts:'2026-11-20T12:00:00Z', ...input })
  const work = await add('工作区里的决定', { source:'work', kind:'decision', matterId:task.id, body:'文'.repeat(601) })
  const chat = await add('主仓这件事的聊天')
  const done = await add('已经兑现', { kind:'commitment' })
  await f.threads.updateEntry(done, { status:'done' })
  const stale = await add('旧说法')
  await f.threads.updateEntry(stale, { status:'superseded' })
  const privateThread = await f.topic('私人话题', true)
  const otherThread = await f.topic('别人的话题', false, 'other')
  const privateEntry = await add('私有', { threadId: privateThread, source:'work', matterId:task.id })
  const otherEntry = await add('其他所有者', { threadId: otherThread, source:'work', matterId:task.id })
  const disallowed = await add('没有事项权限', { source:'work', matterId:f.task(f.repo,'other').id })
  const before = f.store.list()
  const first = PlaceMapResponse.parse(await f.reader.map(f.key))
  expect(first.items.filter(item => item.id.startsWith('e:')).map(item => item.id).sort()).toEqual([work,chat,done].map(id => 'e:'+id).sort())
  expect(first.items).toContainEqual(expect.objectContaining({ id:'e:'+work, body:'文'.repeat(600), from:expect.objectContaining({ matterId:task.id }) }))
  expect(first.items).toContainEqual(expect.objectContaining({ id:'e:'+done, status:'done' }))
  expect(first.items).toContainEqual(expect.objectContaining({ id:'a:terminal:ask-session', line:'要继续吗' }))
  expect(first.items.some(item => item.id === 's:ask-session')).toBe(false)
  expect(first.items.some(item => [stale,privateEntry,otherEntry,disallowed].includes(item.id.slice(2)))).toBe(false)
  expect(await f.reader.map(f.key)).toEqual(first)
  expect(f.store.list()).toEqual(before)
  expect(f.store.list()).toHaveLength(0)
  f.reader.read('operator')
  const saved = f.store.list()
  await f.reader.map(f.key)
  expect(f.store.list()).toEqual(saved)
  await f.topic('melon')
  const ambiguous = PlaceMapResponse.parse(await f.reader.map(f.key))
  expect(ambiguous.items.some(item => item.id === 'e:'+chat)).toBe(false)
  expect(ambiguous.items.some(item => item.id === 'e:'+work)).toBe(true)
  expect(ambiguous.revision).not.toBe(first.revision)
})

it('上限只算可见条目，更新时间降序，第 61 条才截断', async () => {
  const f = fixture()
  const matter = f.task(f.repo)
  const threadId = await f.topic('工作')
  const add = (n: number) => f.threads.addEntry({ threadId, kind:'progress', source:'work', matterId:matter.id,
    line:String(n), ts:new Date(now+n*1_000).toISOString() })
  for (let n = 0; n < 60; n++) await add(n)
  expect((await f.reader.map(f.key))?.truncated).toBe(false)
  await add(60)
  const result = PlaceMapResponse.parse(await f.reader.map(f.key))
  expect(result.truncated).toBe(true)
  expect(result.items.filter(item => item.kind === 'progress').map(item => Number(item.line))).toEqual(Array.from({length:60}, (_, i) => 60-i))
  expect(result.items).toContainEqual(expect.objectContaining({ id:'m:'+matter.id }))
})

it('HTTP 只给 operator，未知地方 404，设备与链接在面板入口也到不了', async () => {
  const f = fixture()
  const stateDir = mkdtempSync(join(tmpdir(),'cc-place-map-http-'))
  cleanups.push(() => rmSync(stateDir,{recursive:true,force:true}))
  const api = createInternalApi({stateDir,daemonPid:1})
  api.provide({places:f.reader})
  cleanups.push(() => api.stop())
  const started = await api.start()
  const url = (key: string) => `http://127.0.0.1:${started.port}/v1/places/map?key=${encodeURIComponent(key)}`
  const get = (tokenFile: string, key: string) => fetch(url(key), { headers:{authorization:'Bearer '+readFileSync(tokenFile,'utf8').trim()} })
  expect((await get(started.operatorTokenFilePath, f.key)).status).toBe(200)
  expect((await get(started.tokenFilePath, f.key)).status).toBe(403)
  const missing = await get(started.operatorTokenFilePath, 'p:0000000000000000')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({error:'place_not_found'})
  for (const origin of ['device','link'] as const) {
    const blocked = await api.panelDispatch(new Request(url(f.key)), { tier:'admin', origin, routeAllow:new Set(['GET /v1/places/map']) },
      { frameBudget:100_000, client:'web' })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({error:'route_not_allowed'})
  }
})

it('operator 可以写、改、放回去，revision 跟随摆放，话题原行逐字段不变', async () => {
  const f = fixture()
  const matter = f.task(f.repo)
  const threadId = await f.topic('工作')
  const id = await f.threads.addEntry({ threadId, kind:'conclusion', source:'work', matterId:matter.id,
    line:'主人原话', body:'正文', ts:new Date(now).toISOString() })
  const before = f.db.query('SELECT * FROM topic_entries WHERE id=?').get(id)
  const stateDir = mkdtempSync(join(tmpdir(),'cc-place-map-pin-http-'))
  cleanups.push(() => rmSync(stateDir,{recursive:true,force:true}))
  const log: unknown[][] = []
  const api = createInternalApi({stateDir,daemonPid:1, log:(...args) => { log.push(args) }})
  api.provide({places:f.reader})
  cleanups.push(() => api.stop())
  const started = await api.start()
  const path = '/v1/places/map/pin'
  const url = `http://127.0.0.1:${started.port}${path}`
  const operator = readFileSync(started.operatorTokenFilePath,'utf8').trim()
  const file = readFileSync(started.tokenFilePath,'utf8').trim()
  const body = { key:f.key, itemId:'e:'+id, branch:'open' }
  const request = (input: unknown, token = operator) => fetch(url, {
    method:'POST', headers:{authorization:'Bearer '+token, 'content-type':'application/json'}, body:JSON.stringify(input),
  })
  const get = async () => PlaceMapResponse.parse(await (await fetch(
    `http://127.0.0.1:${started.port}/v1/places/map?key=${encodeURIComponent(f.key)}`,
    {headers:{authorization:'Bearer '+operator}},
  )).json())
  const initial = await get()
  for (const [input, status, error] of [
    [{...body, key:'p:0000000000000000'}, 404, 'place_not_found'],
    [{...body, itemId:'e:missing'}, 404, 'place_map_item_not_found'],
    [{...body, itemId:'a:terminal:ask-session'}, 409, 'place_map_item_fixed'],
  ] as const) {
    const response = await request(input)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({error})
  }
  // 形状不对走通用的那条回绝:回的话和日志里都不带请求里的字。
  const malformed = await request({...body, branch:'主人原话', body:'正文'})
  expect(malformed.status).toBe(400)
  const refusal = await malformed.text()
  expect(JSON.parse(refusal).error).toBe('invalid_request')
  expect(refusal).not.toMatch(/主人原话|正文/)
  expect(JSON.stringify(log)).not.toMatch(/主人原话|正文/)
  expect((await request(body, file)).status).toBe(403)
  const session = api.mintSessionToken('admin', 'codex/default/'+owner)
  expect((await request(body, session)).status).toBe(403)
  for (const origin of ['device','link'] as const) {
    const blocked = await api.panelDispatch(new Request(url, {method:'POST', body:JSON.stringify(body)}),
      {tier:'admin', origin, routeAllow:new Set(['POST '+path])}, {frameBudget:100_000, client:'web'})
    expect(blocked.status).toBe(403)
  }
  expect(f.db.query('SELECT * FROM place_map_pins').all()).toEqual([])
  let revision = initial.revision
  for (const branch of ['open','active',null] as const) {
    const response = await request({...body, branch})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ok:true})
    const current = await get()
    expect(current.revision).not.toBe(revision)
    expect(current.items.find(item => item.id === body.itemId)?.pin).toBe(branch ?? undefined)
    expect(f.db.query('SELECT * FROM topic_entries WHERE id=?').get(id)).toEqual(before)
    revision = current.revision
  }
  expect(revision).toBe(initial.revision)
  expect(f.db.query('SELECT * FROM place_map_pins').all()).toEqual([])
})

it('沿显式归并链读最近摆放，最多八层；放回去会清掉能继承的摆放', async () => {
  const f = fixture()
  const matter = f.task(f.repo)
  const threadId = await f.topic('工作')
  const add = (line: string) => f.threads.addEntry({ threadId, kind:'progress', source:'work', matterId:matter.id,
    line, ts:new Date(now).toISOString() })
  const first = await add('起点')
  const other = await add('另一条旧记录')
  const pin = (id: string, branch: 'open' | 'active' | 'noted' | null) => f.reader.pin({key:f.key,itemId:'e:'+id,branch})
  const readPin = async (id: string) => (await f.reader.map(f.key))?.items.find(item => item.id === 'e:'+id)?.pin
  const replace = (old: string, next: string) => f.threads.updateEntry(old, {status:'superseded', supersededBy:next})
  expect(await pin(first,'open')).toBeNull()
  expect(await pin(other,'active')).toBeNull()
  f.db.query("UPDATE place_map_pins SET updated_ts='2000-01-01T00:00:00.000Z' WHERE item_id=?").run('e:'+first)
  const step = await add('第一层')
  await replace(first,step)
  expect(await readPin(step)).toBe('open')
  const merged = await add('第二层归并')
  await replace(step,merged)
  expect(await readPin(merged)).toBe('open')
  await replace(other,merged)
  const rows = () => f.db.query('SELECT * FROM place_map_pins ORDER BY item_id').all()
  const saved = rows()
  expect(await readPin(merged)).toBe('active')
  expect(rows()).toEqual(saved)
  expect(await pin(merged,'noted')).toBeNull()
  expect(await readPin(merged)).toBe('noted')
  expect(await pin(merged,null)).toBeNull()
  expect(await readPin(merged)).toBeUndefined()
  expect(rows()).toEqual([])

  expect(await pin(merged,'open')).toBeNull()
  let last = merged
  for (let depth=1; depth<=9; depth++) {
    const next = await add('第 '+depth+' 层')
    await replace(last,next)
    expect(await readPin(next)).toBe(depth <= 8 ? 'open' : undefined)
    last = next
  }
})
