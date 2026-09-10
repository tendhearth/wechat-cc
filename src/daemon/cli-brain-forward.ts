/**
 * cli-brain-forward.ts — 手那边:本机终端会话的事件 / 权限请求不在本机决定,转给脑
 * (spec 2026-09-09-cli-hook-push §6.5)。脑有微信、有全局视角;手只有键盘和屏幕。
 *
 * 在场判断留在信号所在的机器上:人就在这只手前(本机空闲短),直接落本机桌面通知、
 * 权限交给终端自己问 —— 不用绕到脑。人不在,才转。
 */
import type { A2AAgentRecord } from '../lib/agent-config'
import type { CliEvent, CliEventAction } from '../core/cli-events'
import { PRESENT_IDLE_S, formatCliHeader, stripMarkdown, summarizeOneLine } from '../core/cli-events'
import type { CliPermissionRequest, CliPermissionOpen, CliPermissionStatus } from '../core/cli-permission-relay'

export interface BrainLink { id: string; url: string; key: string }

export interface BrainForwarderDeps {
  registry: { list(): readonly A2AAgentRecord[] }
  client: { send(req: { url: string; bearer: string; body: unknown }): Promise<{ ok: boolean; response?: unknown; error?: string; http_status?: number }> }
  /** 本机在脑那里登记的 id(agent_id)。 */
  selfId: string
  notifyDesktop?: (title: string, body: string) => Promise<boolean>
  projectName: (cwd: string) => string
  log: (tag: string, line: string) => void
}

export interface BrainForwarder {
  /** 有没有一只能叫回去的脑(配对时带了 url + key 的)。 */
  brain(): BrainLink | null
  event(ev: CliEvent): Promise<CliEventAction>
  permissionOpen(req: CliPermissionRequest): Promise<CliPermissionOpen | null>
  permissionWait(hash: string, waitMs: number): Promise<CliPermissionStatus>
  /** 这个 hash 是不是在脑那边开的(轮询要去脑那儿问)。 */
  ownsHash(hash: string): boolean
}

const PLACEHOLDER_URL = 'http://brain.local/a2a'

/** 脑的 a2a 地址可能带着 /a2a 尾巴(hand 记录的都是 …/a2a);去掉再拼路径。 */
function baseOf(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/a2a$/, '')
}

export function makeBrainForwarder(deps: BrainForwarderDeps): BrainForwarder {
  const remoteHashes = new Set<string>()

  function brain(): BrainLink | null {
    for (const a of deps.registry.list()) {
      if (!a.may_exec || a.paused) continue
      if (!a.url || a.url === PLACEHOLDER_URL) continue
      if (!a.outbound_api_key || a.outbound_api_key === 'unused') continue
      return { id: a.id, url: baseOf(a.url), key: a.outbound_api_key }
    }
    return null
  }

  async function post(link: BrainLink, path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const r = await deps.client.send({ url: `${link.url}${path}`, bearer: link.key, body: { ...body, agent_id: deps.selfId } })
    if (!r.ok) { deps.log('CLI_FORWARD', `${path} → ${link.id} failed: ${r.error ?? `http_${r.http_status ?? '?'}`}`); return null }
    return (r.response && typeof r.response === 'object') ? r.response as Record<string, unknown> : {}
  }

  return {
    brain,
    async event(ev) {
      const link = brain()
      if (!link) return 'noop'
      // 人就在这只手前:本机桌面说一声就够,不必惊动脑(脑也够不着这块屏幕)。
      if (ev.kind === 'stop' && typeof ev.idle_s === 'number' && ev.idle_s < PRESENT_IDLE_S) {
        const body = ev.text ? summarizeOneLine(stripMarkdown(ev.text), 120) : ''
        const ok = deps.notifyDesktop ? await deps.notifyDesktop(formatCliHeader(ev, safeName(deps.projectName, ev.cwd)), body).catch(() => false) : false
        deps.log('CLI_FORWARD', `${ok ? 'desktop' : 'skip'} stop ${ev.session_id.slice(0, 6)}: owner at this machine (idle ${Math.round(ev.idle_s)}s)`)
        return 'noop'
      }
      const r = await post(link, '/a2a/cli/event', { ...ev })
      const action = r && typeof r['action'] === 'string' ? r['action'] as CliEventAction : null
      return action ?? 'noop'
    },
    async permissionOpen(req) {
      const link = brain()
      if (!link) return null
      if (typeof req.idle_s === 'number' && req.idle_s < PRESENT_IDLE_S) return { status: 'owner_present' }
      const r = await post(link, '/a2a/cli/permission', { ...req })
      if (!r) return null
      if (r['status'] === 'pending' && typeof r['hash'] === 'string') { remoteHashes.add(r['hash']); return { status: 'pending', hash: r['hash'] } }
      if (r['status'] === 'owner_present') return { status: 'owner_present' }
      return null
    },
    async permissionWait(hash, waitMs) {
      const link = brain()
      if (!link) return 'unknown'
      const r = await post(link, '/a2a/cli/permission', { hash, wait_ms: waitMs })
      if (!r) return 'unknown'
      const st = r['status']
      return (st === 'pending' || st === 'allow' || st === 'deny' || st === 'timeout' || st === 'undelivered') ? st : 'unknown'
    },
    ownsHash(hash) { return remoteHashes.has(hash) },
  }
}

function safeName(fn: (cwd: string) => string, cwd: string): string {
  try { return fn(cwd) } catch { return cwd }
}
