import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../cli/hook'
import { makeTerminalHooksService, LOCATE_TTL_MS, SESSIONS_WINDOW_MS } from './terminal-hooks'
import { cliEventRoutes } from './internal-api/routes-cli-events'
import { minTierFor } from './internal-api/route-tiers'
import { REQUEST_SCHEMAS } from './internal-api/schema'
import type { InternalApiDeps } from './internal-api/types'
import type { TerminalHooksDeps } from '../cli/terminal-hooks'

// 临时 HOME / CODEX_HOME:绝不碰主人真的配置。
const tmpDirs: string[] = []
let home: string
let sidecar: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wechat-cc-term-svc-')); tmpDirs.push(home)
  sidecar = join(home, 'tendhearth-cc-cli'); writeFileSync(sidecar, '')
})
afterAll(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

const NOW = 1_800_000_000_000
const make = (locate: TerminalHooksDeps['locate'], sessions: Array<{ last_event_at: number }> = [], now = () => NOW) => makeTerminalHooksService({
  deps: () => ({ home, env: { CODEX_HOME: join(home, 'cx') }, self: { execPath: sidecar, compiled: true, cliEntry: '' }, locate, exists: existsSync }),
  sessions: () => sessions, now,
})

describe('makeTerminalHooksService', () => {
  it('一家都没有 ⇒ capabilityInput null(那一行不出现)', () => {
    expect(make(() => null).capabilityInput()).toBeNull()
  })
  it('只有 Cursor IDE(~/.cursor 在、没装 cursor-agent)也算这台机上有 Cursor', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true })
    expect(make(() => null).capabilityInput()).toEqual({ sources: [{ source: 'cursor', health: 'missing' }], sessions7d: 0 })
  })
  it('只列这台机上有的;sessions7d 只数 7 天内有动静的', () => {
    const svc = make(s => s === 'codex' ? '/bin/codex' : null, [{ last_event_at: NOW - 1000 }, { last_event_at: NOW - SESSIONS_WINDOW_MS + 1 }, { last_event_at: NOW - SESSIONS_WINDOW_MS - 1 }])
    expect(svc.capabilityInput()).toEqual({ sources: [{ source: 'codex', health: 'missing' }], sessions7d: 2 })
    installHooks(join(home, '.claude', 'settings.json'), 'claude', `"${join(home, 'gone', 'wechat-cc-cli')}" hook claude`)
    expect(svc.capabilityInput()!.sources).toEqual([{ source: 'claude', health: 'stale' }, { source: 'codex', health: 'missing' }])
  })
  it('找 CLI 的结果缓存 5 分钟;接上 / 撤掉之后清掉', () => {
    let t = NOW
    const locate = vi.fn((s: string) => s === 'claude' ? '/bin/claude' : null)
    const svc = make(locate, [], () => t)
    svc.capabilityInput(); svc.capabilityInput()
    expect(locate).toHaveBeenCalledTimes(3)   // 三家各一次
    t += LOCATE_TTL_MS + 1
    svc.capabilityInput()
    expect(locate).toHaveBeenCalledTimes(6)
    const r = svc.install()
    expect(r.ok).toBe(true)
    expect(r.results.map(x => [x.source, x.changed])).toEqual([['claude', true]])
    expect(r.status.map(s => [s.source, s.health])).toEqual([['claude', 'ok'], ['codex', 'missing'], ['cursor', 'missing']])
    expect(svc.capabilityInput()).toEqual({ sources: [{ source: 'claude', health: 'ok' }], sessions7d: 0 })
  })
  it('sessions 读不到 ⇒ 当 0,不让整行挂掉', () => {
    const svc = makeTerminalHooksService({ deps: () => ({ home, env: { CODEX_HOME: join(home, 'cx') }, self: { execPath: sidecar, compiled: true, cliEntry: '' }, locate: () => '/bin/x', exists: existsSync }), sessions: () => { throw new Error('db') } })
    expect(svc.capabilityInput()!.sessions7d).toBe(0)
  })
})

describe('POST /v1/cli/hooks/install|uninstall', () => {
  const routes = (svc?: InternalApiDeps['cliHooks']) => cliEventRoutes({ cliHooks: svc } as unknown as InternalApiDeps)
  type Res = { status: number; body: { ok: boolean; results: Array<{ source: string; changed?: boolean }>; status: Array<{ health: string }> } }
  it('没接线 ⇒ 503', async () => {
    expect(await routes()['POST /v1/cli/hooks/install']!(new URLSearchParams(), {})).toEqual({ status: 503, body: { error: 'cli_hooks_not_wired' } })
    expect(await routes()['POST /v1/cli/hooks/uninstall']!(new URLSearchParams(), {})).toEqual({ status: 503, body: { error: 'cli_hooks_not_wired' } })
  })
  it('接上 → 再接一次什么都不改 → 撤掉 → 再撤一次什么都不改(临时文件上)', async () => {
    const r = routes(make(() => '/bin/found'))
    const q = new URLSearchParams()
    const first = await r['POST /v1/cli/hooks/install']!(q, {}) as Res
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.results.map(x => [x.source, x.changed])).toEqual([['claude', true], ['codex', true], ['cursor', true]])
    expect(first.body.status.map(s => s.health)).toEqual(['ok', 'ok', 'ok'])
    expect(existsSync(join(home, '.cursor', 'hooks.json'))).toBe(true)   // 临时 HOME 里的,不是主人的
    const second = await r['POST /v1/cli/hooks/install']!(q, {}) as Res
    expect(second.body).toMatchObject({ ok: true, results: [] })
    const forced = await r['POST /v1/cli/hooks/install']!(q, { sources: ['codex'] }) as Res
    expect(forced.body.results.map(x => x.changed)).toEqual([false])
    const off = await r['POST /v1/cli/hooks/uninstall']!(q, {}) as Res
    expect(off.body.results.map(x => x.changed)).toEqual([true, true, true])
    expect(off.body.status.map(s => s.health)).toEqual(['missing', 'missing', 'missing'])
    const again = await r['POST /v1/cli/hooks/uninstall']!(q, { sources: ['claude'] }) as Res
    expect(again.body.results.map(x => x.changed)).toEqual([false])
  })
  it('schema:sources 只认三家、可省;tier 是 admin', () => {
    for (const k of ['POST /v1/cli/hooks/install', 'POST /v1/cli/hooks/uninstall']) {
      const s = REQUEST_SCHEMAS[k]!
      expect(s.safeParse({}).success).toBe(true)
      expect(s.safeParse({ sources: ['claude', 'codex'] }).success).toBe(true)
      expect(s.safeParse({ sources: ['claude', 'codex', 'cursor'] }).success).toBe(true)
      expect(s.safeParse({ sources: ['gemini'] }).success).toBe(false)
      expect(s.safeParse({ sources: [] }).success).toBe(false)
      expect(minTierFor(k)).toBe('admin')
    }
  })
})
