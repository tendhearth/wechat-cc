/**
 * 手机「额度用完 ⇒ 交给另一位继续」(spec 2026-10-01-tendhearth-continue-sessions §7-3)对着真面板 + 真工作台:
 * 执行者真报额度错误 ⇒ 详情带 offer ⇒ POST /m/api/matter/handoff 在同一文件夹给另一位新开一件 ⇒ 详情变 handed;
 * 同一 requestId / 另一个 requestId 都不建第二件;每个回包过协议 schema。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { removeTempDir } from '../lib/test-temp'
import { openDb, type Db } from '../lib/db'
import { createProviderRegistry } from '../core/provider-registry'
import { makeMatterStore } from '../core/matters/store'
import { makeMattersService } from '../core/matters/service'
import { makeWorkbenchStore } from '../core/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../core/workbench/service'
import { MANAGED_NATIVE_CAPABILITIES } from '../core/workbench/executor-capabilities'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'

const QUOTA = "You've hit your usage limit. Try again at 10:00"

describe('手机 · 额度用完交给另一位(真面板 + 真工作台)', () => {
  let root: string, db: Db, workbench: WorkbenchService, panel: SettingsPanel, base: string, token: string
  let matters: ReturnType<typeof makeMatterStore>
  const prompts: Array<{ provider: string; text: string; cwd: string }> = []

  beforeEach(async () => {
    prompts.length = 0
    root = realpathSync(mkdtempSync(join(tmpdir(), 'phone-quota-handoff-')))
    db = openDb({ path: join(root, 'state.db') })
    matters = makeMatterStore(db)
    const store = makeWorkbenchStore(db)
    const registry = createProviderRegistry()
    const fake = (provider: string, fail: boolean) => ({
      async spawn(project: { cwd?: string } | string) {
        const cwd = typeof project === 'string' ? project : String((project as { cwd?: string }).cwd ?? '')
        return {
          async *dispatch(text: string) {
            prompts.push({ provider, text, cwd })
            yield { kind: 'init' as const, sessionId: `${provider}-session` }
            if (fail) { yield { kind: 'error' as const, message: QUOTA }; return }
            yield { kind: 'text' as const, text: '接着做好了' }
            yield { kind: 'result' as const, sessionId: `${provider}-session` }
          },
          async steer() {},
          async close() {},
        }
      },
    })
    registry.register('claude', fake('claude', true) as never, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
    registry.register('codex', fake('codex', false) as never, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
    workbench = makeWorkbenchService({ store, registry, stateDir: root, ownerChatId: () => 'owner', defaultProvider: 'claude', matters })
    const service = makeMattersService({ store: matters, workbench })
    panel = makeSettingsPanel({
      stateDir: root, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
      matters: { ...service, say: (id, text, input) => service.say(id, text, 'phone', input), seenOnPhone: id => { matters.bind(id, 'phone', 'pwa') } },
    })
    const started = await panel.start(0)
    base = `http://127.0.0.1:${started.port}`
    token = panel.issueToken()
  })
  afterEach(async () => { await panel?.stop(); await workbench?.shutdown(); db?.close(); removeTempDir(root) })

  const request = (path: string, body?: unknown) =>
    fetch(base + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const parseAs = (key: string, body: unknown) => PHONE_API_SCHEMAS[key]!.parse(body) as Record<string, unknown>
  const detail = async (id: string) => parseAs('GET /m/api/matter', await (await request(`/m/api/matter?id=${id}`)).json())

  it('额度错误 ⇒ offer ⇒ 交出去(同一文件夹、Codex、第一句说清接替谁)⇒ handed;重发 / 另一台设备都回同一件', async () => {
    const project = join(root, 'proj'); mkdirSync(project)
    const task = workbench.create({ path: project, providerId: 'claude', text: '修登录页' })
    await expect.poll(() => workbench.detail(task.id).task.status).toBe('failed')
    expect(workbench.detail(task.id).task.error).toBe('provider_quota_exhausted')

    const before = await detail(task.id)
    expect(before.quotaHandoff).toMatchObject({ state: 'offer', from: 'claude', to: 'codex', kind: 'quota' })

    const requestId = randomUUID()
    const res = await request('/m/api/matter/handoff', { id: task.id, requestId, providerId: 'codex' })
    expect(res.status).toBe(200)
    const made = parseAs('POST /m/api/matter/handoff', await res.json()) as { ok: true; matterId: string; created: boolean }
    expect(made.created).toBe(true); expect(made.matterId).not.toBe(task.id)
    expect(matters.bindings(made.matterId).some(b => b.surface === 'phone')).toBe(true)
    expect(matters.get(made.matterId)?.originMatterId).toBe(task.id)
    await expect.poll(() => prompts.some(p => p.provider === 'codex')).toBe(true)
    const codex = prompts.find(p => p.provider === 'codex')!
    expect(codex.text).toContain('接替 Claude（额度用完）继续这件事')
    expect(workbench.detail(made.matterId).task).toMatchObject({ providerId: 'codex', path: project })

    expect((await detail(task.id)).quotaHandoff).toEqual({ state: 'handed', from: 'claude', to: 'codex', matterId: made.matterId })
    const again = parseAs('POST /m/api/matter/handoff', await (await request('/m/api/matter/handoff', { id: task.id, requestId, providerId: 'codex' })).json())
    expect(again).toEqual({ ok: true, matterId: made.matterId, created: false })
    const other = parseAs('POST /m/api/matter/handoff', await (await request('/m/api/matter/handoff', { id: task.id, requestId: randomUUID(), providerId: 'codex' })).json())
    expect(other).toEqual({ ok: true, matterId: made.matterId, created: false })
    expect(workbench.list({ limit: 50 }).tasks).toHaveLength(2)
  })

  it('卡上的接手人对不上 ⇒ 409 quota_handoff_changed,不建;额度没用完 ⇒ 409 quota_handoff_not_needed', async () => {
    const project = join(root, 'proj2'); mkdirSync(project)
    const ok = workbench.create({ path: project, providerId: 'codex', text: '小改动' })
    await expect.poll(() => workbench.detail(ok.id).task.status).toBe('completed')
    expect((await detail(ok.id)).quotaHandoff).toBeUndefined()
    const notNeeded = await request('/m/api/matter/handoff', { id: ok.id, requestId: randomUUID(), providerId: 'claude' })
    expect(notNeeded.status).toBe(409); expect(parseAs('POST /m/api/matter/handoff', await notNeeded.json())).toEqual({ ok: false, error: 'quota_handoff_not_needed' })

    const failed = workbench.create({ path: project, providerId: 'claude', text: '大改动' })
    await expect.poll(() => workbench.detail(failed.id).task.status).toBe('failed')
    const changed = await request('/m/api/matter/handoff', { id: failed.id, requestId: randomUUID(), providerId: 'gemini' })
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ ok: false, error: 'quota_handoff_changed' })
    expect(workbench.list({ limit: 50 }).tasks).toHaveLength(2)
  })
})
