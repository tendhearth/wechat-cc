/** Share acceptance driver. Evidence contains assertions and counts, never replies or links. */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeProtocolClient, type ProtocolClient } from '@wechat-cc/protocol'

const dir = resolve(process.env.WECHAT_STATE_DIR ?? '')
if (!dir.startsWith('/private/tmp/') || !dir.includes('/acc/state/') || !existsSync(join(dir, '.acceptance-only')) || !existsSync(join(dir, '.share-acceptance'))) throw Error('marked share acceptance state required')
const command = process.argv[2]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function check(id: string, ok: boolean, detail: Record<string, number | boolean | string> = {}) {
  const row = { at: new Date().toISOString(), id, ok, ...detail }
  appendFileSync(join(dir, 'share-evidence.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
  if (!ok) throw Error('acceptance assertion failed')
}
function read(name: string) { return JSON.parse(readFileSync(join(dir, name), 'utf8')) }
function rows(name: string): any[] { return existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [] }
function loopback(base: string) { if (new URL(base).hostname !== '127.0.0.1') throw Error('loopback required'); return base }
async function api(method: string, path: string, body?: unknown, control = false, token = 'internal-operator-token') {
  const base = loopback(control ? read('ready.json').controlUrl : read('internal-api-info.json').baseUrl)
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(!control ? { authorization: 'Bearer ' + readFileSync(join(dir, token), 'utf8').trim() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) })
  const text = await r.text()
  let value: any; try { value = JSON.parse(text) } catch { value = {} }
  return { status: r.status, body: value }
}
async function until(fn: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(300) }
  return false
}
const clients: ProtocolClient[] = []
function guest(url: string) {
  const u = new URL(url), relay = loopback(read('share-relay.json').base)
  if (u.hostname !== '127.0.0.1' || u.host !== new URL(relay).host) throw Error('local share link required')
  const token = new URLSearchParams(u.hash.slice(1)).get('t')
  if (!token || !/^s[a-f0-9]{64}$/.test(token)) throw Error('share token missing')
  const c = makeProtocolClient({ token, client: 'web', requestTimeoutMs: 5000, requestDeadlineMs: 12000, retries: 0, open() {
    const ws = new WebSocket(relay + '/v2/phone')
    return { send: s => ws.send(s), close: () => ws.close(), onOpen: cb => ws.addEventListener('open', cb), onMessage: cb => ws.addEventListener('message', ev => cb(String(ev.data))), onClose: cb => ws.addEventListener('close', cb) }
  } })
  clients.push(c)
  return c
}
function save(value: unknown) { writeFileSync(join(dir, 'share-fixture.json'), JSON.stringify(value), { mode: 0o600 }) }
async function makeLink(matter: string, mode = 'discuss') {
  const r = await api('POST', '/v1/matter/share', { matter, name: '小林', mode })
  check('link-' + mode, r.status === 200 && !!r.body.url, { status: r.status })
  return r.body
}
async function projection(c: ProtocolClient, matter: string) {
  const r = await c.request({ method: 'GET', path: '/share/state?matter=other' }), text = r.text(), body = r.json<any>()
  check('b-projection', r.status === 200 && body.matter?.title === '首页配色' && !text.includes('ACC_PRIVATE_MEMORY_CANARY') && !text.includes('ACC_OTHER_MATTER_CANARY') && !text.includes(matter), { status: r.status, throughTunnel: true })
  const page = await c.request({ method: 'GET', path: '/share' })
  check('b-page', page.status === 200 && page.text().includes('请你看看这件事'))
  const denied = await c.request({ method: 'GET', path: '/v1/matters' })
  check('b-scope', denied.status === 401)
}
async function view(matter: string) {
  const link = await makeLink(matter, 'view'), c = guest(link.url)
  const state = await c.request({ method: 'GET', path: '/share/state' })
  check('e-can-view', state.status === 200)
  const r = await c.request({ method: 'POST', path: '/share/say', body: JSON.stringify({ text: '按钮颜色太淡了,能不能深一点' }) })
  check('e-view-only', r.status === 403 && r.json<any>().error === 'share_view_only', { status: r.status })
  await api('POST', '/v1/matter/share/revoke', { matter, id: link.share.id })
}
async function ownerTurn(text: string, decision?: 'allow' | 'deny') {
  let settled = false, seen = 0
  const work = api('POST', '/v1/companion/converse', { text }).finally(() => { settled = true })
  const end = Date.now() + 180000
  while (!settled && Date.now() < end) {
    const pending = await api('GET', '/v1/permissions/pending')
    for (const p of pending.body.items ?? []) {
      if (p.chatId !== 'acc-owner' || !/matter_share/.test(p.prompt ?? '') || !decision) continue
      check('a-pending-card', /首页配色/.test(p.prompt) && /小林/.test(p.prompt))
      seen++
      const r = await api('POST', '/v1/permissions/resolve', { hash: p.hash, decision })
      check('a-card-' + decision, r.status === 200 && r.body.ok === true)
    }
    await sleep(300)
  }
  const r = await work
  check('owner-turn', r.status === 200, { status: r.status })
  if (decision) check('a-tool-and-card', seen > 0)
  return String(r.body.reply ?? '')
}
async function a() {
  check('online-mode', !existsSync(join(dir, '.share-offline')))
  // 换模式只认文件令牌(operator 会 403 route_not_allowed)。
  check('a-mode', (await api('POST', '/v1/conversation/set-mode', { chatId: 'acc-owner', mode: { kind: 'solo', provider: process.env.SHARE_ACC_PROVIDER ?? 'openai' }, quiet: true }, false, 'internal-token')).status === 200)
  const made = await api('POST', '/v1/workbench/create', { title: '首页配色', path: join(dir, 'workspace'), providerId: 'openai', text: '只回复：首页配色方案已备好。不要使用工具。' })
  check('a-operator-create', made.status === 202 && !!made.body.task?.id)
  const matter = made.body.task.id
  check('a-task-settled', await until(async () => {
    const r = await api('GET', '/v1/workbench/task?id=' + matter)
    return ['completed', 'failed', 'cancelled'].includes(r.body.task?.status ?? r.body.status)
  }, 180000))
  const before = (await api('GET', '/v1/matter/shares?matter=' + matter)).body.shares ?? []
  const denied = await ownerTurn('把首页配色这件事分享给小林,让他帮我看看', 'deny')
  const after = (await api('GET', '/v1/matter/shares?matter=' + matter)).body.shares ?? []
  check('a-denial-no-link-record', !/s[a-f0-9]{64}|\/pset\//.test(denied) && after.length === before.length)
  const reply = await ownerTurn('现在重新请你把首页配色这件事分享给小林,让他帮我看看', 'allow')
  const url = reply.match(/(?:https?|wss?):\/\/127\.0\.0\.1:[0-9]+\/pset\/#[^\s<>"）)]+/)?.[0]
  check('a-approved-reply-link', !!url)
  const shares = (await api('GET', '/v1/matter/shares?matter=' + matter)).body.shares ?? []
  check('a-one-share', shares.length === before.length + 1)
  check('a-tool-observed', await until(async () => rows('gateway-responses.jsonl').some(r => (r.toolCalls ?? []).some((name: string) => /(?:^|__)matter_share$/.test(name)))))
  check('a-other-matter', (await api('POST', '/share-seed', { canaryOnly: true }, true)).status === 200)
  save({ matter, url, share: shares.at(-1) })
}
async function c(f: any) {
  check('online-mode', !existsSync(join(dir, '.share-offline')))
  const client = guest(f.url)
  const talkBefore = (await client.request({ method: 'GET', path: '/share/state' })).json<any>().matter?.talk ?? []
  const ccBefore = talkBefore.filter((x: any) => x.who === 'cc').length
  const outBefore = (await api('GET', '/outbox', undefined, true)).body.length
  const before = rows('gateway.jsonl').length
  const r = await client.request({ method: 'POST', path: '/share/say', body: JSON.stringify({ text: '按钮颜色太淡了,能不能深一点' }) })
  check('c-say', r.status === 200)
  check('c-cc-reply', await until(async () => {
    const state = (await client.request({ method: 'GET', path: '/share/state' })).json<any>()
    return (state.matter?.talk?.filter((x: any) => x.who === 'cc').length ?? 0) > ccBefore && state.matter?.talk?.some((x: any) => x.who === 'guest' && x.text === '按钮颜色太淡了,能不能深一点') === true
  }))
  const calls = rows('gateway.jsonl').slice(before).filter(x => x.hasShareReplyPrompt === true)
  check('c-model-isolation', calls.length > 0 && calls.every(x => x.toolCount === 0 && x.hasMemoryCanary === false), { requests: calls.length })
  check('c-owner-notified', await until(async () => {
    const out = (await api('GET', '/outbox', undefined, true)).body.slice(outBefore)
    return out.some((m: any) => m.chatId === 'acc-owner' && /首页配色/.test(m.text) && /提了个想法/.test(m.text))
  }))
}
async function d(f: any, natural: boolean) {
  // Keep this authenticated stream alive across revocation, testing per-request validity.
  const client = guest(f.url)
  check('d-before', (await client.request({ method: 'GET', path: '/share/state' })).status === 200)
  if (natural) await ownerTurn('小林那个链接关掉')
  else check('d-revoke', (await api('POST', '/v1/matter/share/revoke', { matter: f.matter, id: f.share.id })).body.revoked === true)
  let rejected = false
  try { await client.request({ method: 'GET', path: '/share/state' }) } catch (error) { rejected = error instanceof Error && error.message === 'auth_failed' }
  check('d-tunnel-revoked', rejected, { throughTunnel: true, protocolError: 'auth_failed' })
  const token = new URLSearchParams(new URL(f.url).hash.slice(1)).get('t')
  const probe = await api('POST', '/share-local-probe', { token }, true)
  check('d-revoked-401', probe.status === 401, { status: probe.status, throughTunnel: false, via: 'loopback-control-to-real-panel-handler' })
}
let supervisor: ReturnType<typeof Bun.spawn> | undefined
try {
  if (command === 'offline') {
    check('fresh-offline-state', !existsSync(join(dir, 'pids.json')))
    mkdirSync(join(dir, 'workspace'), { recursive: true })
    supervisor = Bun.spawn(['python3', new URL('./run.py', import.meta.url).pathname, 'start-offline'], { env: { PATH: process.env.PATH!, WECHAT_STATE_DIR: dir }, stdout: Bun.file(join(dir, 'supervisor.log')), stderr: Bun.file(join(dir, 'supervisor-error.log')) })
    check('offline-ready', await until(async () => { if (supervisor?.exitCode !== null) throw Error('supervisor exited'); return existsSync(join(dir, 'ready.json')) }, 22 * 60 * 1000))
    check('relay-login', await until(async () => (await fetch(loopback(read('share-relay.json').base.replace(/^ws:/, 'http:')) + '/status').then(r => r.json()) as any).authenticated === true))
    const seed = await api('POST', '/share-seed', {}, true)
    check('offline-seed', seed.status === 200 && !!seed.body.id)
    const link = await makeLink(seed.body.id), f = { matter: seed.body.id, ...link }
    await projection(guest(f.url), f.matter); await view(f.matter); await d(f, false)
    check('offline-model-requests', rows('offline-model-attempts.jsonl').length === 0, { attempts: rows('offline-model-attempts.jsonl').length })
  } else {
    if (command === 'a' || command === 'all') await a()
    if (command !== 'a') {
      const f = read('share-fixture.json')
      if (command === 'b' || command === 'all') await projection(guest(f.url), f.matter)
      if (command === 'c' || command === 'all') await c(f)
      if (command === 'e' || command === 'all') await view(f.matter)
      if (command === 'd' || command === 'all') await d(f, true)
      if (!['b', 'c', 'd', 'e', 'all'].includes(command!)) throw Error('unknown share command')
    }
  }
} catch {
  appendFileSync(join(dir, 'share-evidence.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: 'scenario-failed', ok: false }) + '\n')
  console.error('share acceptance failed; see redacted evidence')
  process.exitCode = 1
} finally {
  for (const client of clients) client.close()
  if (supervisor) {
    supervisor.kill('SIGTERM')
    await supervisor.exited
    check('offline-cleanup', existsSync(join(dir, 'cleanup.json')) && read('cleanup.json').remainingCount === 0 && read('cleanup.json').remainingGroupMembers === 0)
  }
}
