/**
 * 升级后的兼容自检 —— 和 `wechat-cc selftest chat` / `selftest workbench` 同一套检查,在 daemon 里跑。
 *
 *  1. 对话自检(同 `selftest chat --resume`):daemon 自己的 runSelftestConverse(POST /v1/selftest/converse
 *     背后的那一个函数),一轮「调 wechat MCP 的 ping」+ 一轮续接。检查项与 CLI 同名:replied / tool_seen /
 *     no_error / resume_replied;外加**协议烟测** protocol_events:这一轮经过我们自己的解析器出来的事件里,
 *     text / result(要求工具时还有 tool_call)必须都在 —— CLI 换了输出格式、解析器认不出时它先红。
 *  2. 工作台自检(工作台执行者,同 `selftest workbench --resume`):直接调 CLI 的 runWorkbenchSelftest,
 *     走本机回环的内部 API,和主人在终端里跑的是同一段代码。
 *
 * 自检是**模型调用**,要过网络守护:守护说此刻不安全 ⇒ `deferred`(记「未验证」,稍后再试),**不退回**。
 * 判守护在先(一个字都不发);两段自检里任何一处报 `network_unprotected` 也按 deferred。
 *
 * 同理,**供应商那边**的失败(额度用完、限流、登录失效、key 被拒、连不上、5xx —— 边界产的结构化码)
 * 说明不了 CLI 新版本坏了:也按 deferred,不退回、不记坏版本。只有 CLI 自己的行为(没回话、事件种类缺了、
 * 工具调用没出来、续接断了、工作台检查项不过)才算 fail。
 */
import { isConnectFailure } from '../../lib/net-errors'
import { executionFailureMessage } from '../../core/workbench/execution-settings'
import type { CliSpec } from '../../core/cli-upgrade/specs'
import type { VerifyResult } from '../../core/cli-upgrade/engine'
import type { SelftestConverseResult } from '../selftest'
import type { SelftestReport } from '../../cli/selftest'

export const CHAT_PING_TEXT = '调用 wechat 这个 MCP 服务器上的 ping 工具，把它返回的 daemon_pid 数字告诉我，不要做别的。'
export const CHAT_RESUME_TEXT = '我上一句让你调用的工具叫什么？只回答工具名。'

export interface VerifyDeps {
  hasProvider: (providerId: string) => boolean
  /**
   * 这家没注册时问一句:是不是开机 `--version` 探测一时失败、正在退避重探(2026-10-04)?是 ⇒ 立刻重探
   * 一次(刚升完的新版本可能正好好了)。true = 现在注册上了;false = 还在重探;null / 没接 = 不在重探名单。
   */
  reprobe?: (providerId: string) => Promise<boolean | null>
  /** 此刻这家的一次 spawn 过不过得了网络守护(decideCall)。 */
  guardAllows: (providerId: string) => Promise<{ allowed: boolean; detail?: string }>
  converse: (input: { providerId: string; text: string; resumeSessionId?: string }) => Promise<SelftestConverseResult>
  /** 工作台自检(没有 ⇒ 只跑对话自检)。 */
  workbench?: (providerId: string) => Promise<SelftestReport>
  log: (tag: string, line: string) => void
}

interface Check { name: string; ok: boolean; detail?: string }

const isGuard = (r: { errorCode?: string; error?: string }) => r.errorCode === 'network_unprotected'

/** 供应商侧的失败码(lib/provider-error-code):不是 CLI 的错。`invalid_request` / `provider_error` 不在里面 ——
 *  「模型需要更新的 CLI」这类恰恰是 invalid_request,那正是要抓的。 */
const PROVIDER_SIDE = new Set(['quota', 'rate_limited', 'auth_failed', 'auth_rejected', 'network', 'server_error'])
const providerSide = (r: { errorCode?: string }) => !!r.errorCode && PROVIDER_SIDE.has(r.errorCode)

/** 工作台把同一组码翻成了固定的人话(execution-settings);检查项 detail 里出现这些句子 ⇒ 供应商侧。 */
const WORKBENCH_PROVIDER_SIDE = ['provider_quota_exhausted', 'provider_rate_limited', 'provider_auth_expired', 'provider_auth_rejected', 'provider_network', 'provider_server_error', 'network_unprotected']
  .flatMap(code => [code, executionFailureMessage(code)])
const workbenchProviderSide = (detail: string | undefined) => !!detail && WORKBENCH_PROVIDER_SIDE.some(m => detail.includes(m))

function summarize(checks: Check[]): string {
  const bad = checks.filter(c => !c.ok)
  if (!bad.length) return checks.map(c => c.name).join(' ✓ ') + ' ✓'
  return bad.map(c => `${c.name}${c.detail ? `(${c.detail.slice(0, 120)})` : ''}`).join(';')
}

export async function verifyCliProvider(spec: CliSpec, deps: VerifyDeps): Promise<VerifyResult> {
  const pid = spec.providerId
  if (!deps.hasProvider(pid)) {
    // 开机探测一时失败、还在重探的那家不能按「跑不了自检」直接接受新版本(skipped 会永久免检):
    // 先立刻重探一次;通过了就照常自检,还没好就欠着(deferred),等它注册上再验。
    const re = deps.reprobe ? await deps.reprobe(pid).catch(() => null) : null
    if (re === false) return { status: 'deferred', detail: `${pid} 开机探测失败、还在重探,注册上之后再自检` }
    if (re !== true || !deps.hasProvider(pid)) return { status: 'skipped', detail: `${pid} 这次没在 daemon 里注册,跑不了自检` }
  }
  const g = await deps.guardAllows(pid)
  if (!g.allowed) return { status: 'deferred', detail: `network_unprotected${g.detail ? `:${g.detail}` : ''}` }

  const checks: Check[] = []
  const r1 = await deps.converse({ providerId: pid, text: CHAT_PING_TEXT })
  if (isGuard(r1)) return { status: 'deferred', detail: 'network_unprotected(对话自检被网络守护挡下)' }
  if (providerSide(r1)) return { status: 'deferred', detail: `供应商侧失败 ${r1.errorCode}:${(r1.error ?? '').slice(0, 160)}` }
  checks.push({ name: 'replied', ok: r1.ok && r1.texts.length > 0, detail: r1.error ?? `${r1.texts.length} text(s)` })
  if (spec.requireToolInChat) checks.push({ name: 'tool_seen', ok: r1.toolCalls.includes('wechat/ping'), detail: r1.toolCalls.join(',') || '(none)' })
  checks.push({ name: 'no_error', ok: !r1.error, ...(r1.error ? { detail: `${r1.errorCode ?? ''} ${r1.error}`.trim() } : {}) })
  const kinds = r1.eventKinds ?? []
  const need = ['text', 'result', ...(spec.requireToolInChat ? ['tool_call'] : [])]
  const missing = need.filter(k => !kinds.includes(k))
  checks.push({ name: 'protocol_events', ok: missing.length === 0, detail: missing.length ? `缺 ${missing.join(',')}(见到 ${kinds.join(',') || '无'})` : kinds.join(',') })
  if (r1.sessionId) {
    const r2 = await deps.converse({ providerId: pid, text: CHAT_RESUME_TEXT, resumeSessionId: r1.sessionId })
    if (isGuard(r2)) return { status: 'deferred', detail: 'network_unprotected(续接自检被网络守护挡下)' }
    if (providerSide(r2)) return { status: 'deferred', detail: `供应商侧失败 ${r2.errorCode}:${(r2.error ?? '').slice(0, 160)}` }
    checks.push({ name: 'resume_replied', ok: r2.ok && r2.texts.length > 0, detail: r2.error ?? `${r2.texts.length} text(s)` })
  } else {
    checks.push({ name: 'resume_replied', ok: false, detail: 'no session id from first turn' })
  }

  if (spec.workbench && deps.workbench) {
    let report: SelftestReport | null = null
    try { report = await deps.workbench(pid) } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // daemon 自己的内部 API 没起来不是 CLI 的错。
      if (m === 'daemon_not_running' || isConnectFailure(m)) return { status: 'deferred', detail: `工作台自检没跑起来:${m}` }
      checks.push({ name: 'workbench', ok: false, detail: m })
    }
    if (report) {
      const side = report.checks.find(c => !c.ok && workbenchProviderSide(c.detail))
      if (side) return { status: 'deferred', detail: `工作台自检遇到供应商侧 / 守护的失败:${(side.detail ?? '').slice(0, 160)}` }
      for (const c of report.checks) checks.push({ name: `workbench.${c.name}`, ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) })
    }
  }

  const ok = checks.every(c => c.ok)
  deps.log('CLI_UPGRADE', `${spec.id} 自检 ${ok ? 'PASS' : 'FAIL'}:${summarize(checks)}`)
  return { status: ok ? 'pass' : 'fail', detail: summarize(checks) }
}
