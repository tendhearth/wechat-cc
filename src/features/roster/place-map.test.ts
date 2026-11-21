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
