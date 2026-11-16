/** Terminal attach acceptance (design #942 step 3). Evidence holds assertions and counts only — never tokens or replies. */
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

const dir = resolve(process.env.WECHAT_STATE_DIR ?? '')
if (!dir.startsWith('/private/tmp/') || !dir.includes('/acc/state/') || !existsSync(join(dir, '.acceptance-only'))) throw Error('marked acceptance state required')
const ROOT = resolve(import.meta.dir, '../..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function check(id: string, ok: boolean, detail: Record<string, number | boolean | string> = {}) {
  const row = { at: new Date().toISOString(), id, ok, ...detail }
  appendFileSync(join(dir, 'terminal-evidence.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
  if (!ok) throw Error('acceptance assertion failed')
}
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const rows = (name: string): any[] => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
async function api(method: string, path: string, body?: unknown, token = 'internal-operator-token') {
  const base = read('internal-api-info.json').baseUrl
  if (new URL(base).hostname !== '127.0.0.1') throw Error('loopback required')
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + readFileSync(join(dir, token), 'utf8').trim() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) })
  let value: any; try { value = JSON.parse(await r.text()) } catch { value = {} }
  return { status: r.status, body: value }
}
async function until(fn: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(300) }
  return false
}
async function ownerTurn(text: string, tool: RegExp, expect: RegExp[]) {
  let settled = false, seen = 0
  const work = api('POST', '/v1/companion/converse', { text }).finally(() => { settled = true })
  const end = Date.now() + 180000
  while (!settled && Date.now() < end) {
    for (const p of (await api('GET', '/v1/permissions/pending')).body.items ?? []) {
      if (p.chatId !== 'acc-owner' || !tool.test(p.prompt ?? '')) continue
      check('card-shows-identity', expect.every(r => r.test(p.prompt)))
      seen++
      check('card-allow', (await api('POST', '/v1/permissions/resolve', { hash: p.hash, decision: 'allow' })).body.ok === true)
    }
    await sleep(300)
  }
  const r = await work
  check('owner-turn', r.status === 200 && seen > 0, { status: r.status, cards: seen })
  return String(r.body.reply ?? '')
}
function cli(args: string[], stdin?: string) {
  // The bridge reads only the credential file; give it no daemon env at all.
  const p = Bun.spawnSync(['bun', join(ROOT, 'cli.ts'), ...args], { cwd: ROOT, env: { PATH: process.env.PATH!, HOME: join(dir, 'home') }, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin) })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

check('online-mode', !existsSync(join(dir, '.share-offline')))
check('mode', (await api('POST', '/v1/conversation/set-mode', { chatId: 'acc-owner', mode: { kind: 'solo', provider: process.env.TERM_ACC_PROVIDER ?? 'openai' }, quiet: true }, 'internal-token')).status === 200)
mkdirSync(join(dir, 'workspace'), { recursive: true })
const made = await api('POST', '/v1/workbench/create', { title: '首页配色', path: join(dir, 'workspace'), providerId: 'openai', text: '只回复：首页配色方案已备好。不要使用工具。' })
check('matter-created', made.status === 202 && !!made.body.task?.id)
const matter = made.body.task.id
check('task-settled', await until(async () => ['completed', 'failed', 'cancelled'].includes((await api('GET', '/v1/workbench/task?id=' + matter)).body.task?.status), 180000))

// A Claude terminal session reports in the way its hook would.
const sid = randomUUID(), term = join(dir, 'workspace-terminal')
mkdirSync(term, { recursive: true })
check('hook-registered', (await api('POST', '/v1/cli/event', { source: 'claude', kind: 'prompt', session_id: sid, cwd: term, machine: hostname() }, 'internal-token')).status === 200)

const attached = await ownerTurn('把我终端里这个 Claude 挂到首页配色这件事上', /terminal_attach/, [new RegExp(sid.slice(0, 6)), /首页配色/, /workspace-terminal/])
// Private, local-only: lets a failed run be diagnosed (it is the owner's own reply, no token).
writeFileSync(join(dir, 'attach-reply.txt'), attached, { mode: 0o600 })
const cred = attached.match(/--cred\s+['"]?([^'"\s`]+)/)?.[1]
check('reply-has-instructions', !!cred && attached.includes('你现在挂在「首页配色」这件事上') && /matter notes/.test(attached) && /matter note /.test(attached))
check('reply-no-token', !existsSync(cred!) || !attached.includes(JSON.parse(readFileSync(cred!, 'utf8')).token))
check('credential-private', statSync(cred!).mode % 0o1000 === 0o600 && statSync(join(cred!, '..')).mode % 0o1000 === 0o700)
check('tool-observed', await until(async () => rows('gateway-responses.jsonl').some(r => (r.toolCalls ?? []).some((n: string) => /(?:^|__)terminal_attach$/.test(n)))))
check('pending-before-use', (await api('GET', '/v1/matter?id=' + matter)).body.terminalParticipants?.[0]?.connection === 'pending')

const wrote = cli(['matter', 'note', '--cred', cred!, '终端这边：按钮先试深一号的蓝'])
check('cli-note', wrote.code === 0 && wrote.out.includes('备注已写入'), { code: wrote.code ?? -1 })
const piped = cli(['matter', 'note', '--cred', cred!], '第二条：从 stdin 写')
check('cli-note-stdin', piped.code === 0, { code: piped.code ?? -1 })
const listed = cli(['matter', 'notes', '--cred', cred!])
check('cli-notes', listed.code === 0 && listed.out.includes('深一号的蓝') && listed.out.includes('从 stdin 写'))
const detail = (await api('GET', '/v1/matter?id=' + matter)).body
check('detail-connected', detail.terminalParticipants?.[0]?.connection === 'connected' && (detail.notes ?? []).some((n: any) => /深一号的蓝/.test(n.text)))

await ownerTurn('把终端从首页配色这件事上摘下来', /terminal_detach/, [new RegExp(sid.slice(0, 6)), /首页配色/])
check('credential-removed', !existsSync(cred!))
const after = cli(['matter', 'notes', '--cred', cred!])
check('cli-refused-after-detach', after.code !== 0 && /摘下来了/.test(after.err + after.out), { code: after.code ?? -1 })
const final = (await api('GET', '/v1/matter?id=' + matter)).body
check('detached-shown', final.terminalParticipants?.[0]?.detachedAt != null && (final.notes ?? []).length >= 2)
