import type { CliSetupReceipt } from './cli-setup-receipt'
/** Desktop setup orchestration. Pure injected detections; no installer or login is run here. */
import { CLI_SETUP_IDS, cliSetupAction, cliSetupId, cliSetupInfo, cliSetupPlan, type CliSetupId } from '../lib/executor-cli-setup'
import type { NetworkGateVerdict } from '../lib/network-gate'

export const CLI_SETUP_NETWORK_HINT = '网络保护没开,先打开 bx 再装'
export interface CliSetupDeps {
  stateDir: string
  platform: string
  binary: (id: CliSetupId) => string | null
  guard: () => { enabled: boolean; safe: boolean; source: string }
  checkGuard: () => Promise<NetworkGateVerdict>
  /** Grok has no eval surface; reuse the existing dedicated-HOME presence check. */
  supported?: (id: CliSetupId) => boolean
  beginLogin?: () => CliSetupReceipt
  prepareGrokHome?: () => void
  grokLoggedIn?: () => boolean
}
export function makeCliSetup(deps: CliSetupDeps) {
  let grokAttempt: CliSetupReceipt | undefined
  function snapshot() {
    const g = deps.guard()
    const platformSupported = deps.platform === 'darwin' || deps.platform === 'win32'
    const allowed = g.enabled && g.safe && g.source === 'bx'
    return { ok: true, allowed, blockedReason: allowed ? '' : CLI_SETUP_NETWORK_HINT,
      providers: CLI_SETUP_IDS.map(id => {
        const binary = deps.binary(id), installed = !!binary, info = cliSetupInfo(id, deps.platform)
        const action = installed ? 'login' : 'install'
        const commands = platformSupported && (installed || info.canInstall) ? cliSetupPlan(id, action, deps.stateDir, deps.platform, installed, binary ?? undefined).commands : []
        const runtimeSupported = platformSupported && (deps.supported?.(id) ?? true)
        return { ...info, runtimeSupported, supportNote: runtimeSupported ? '' : platformSupported ? 'CLI 可安装和登录，CC 执行者暂不支持 Windows。' : '当前桌面平台请通过官网接入。', installed, canLogin: installed && platformSupported, commands,
          ...(id === 'grok' ? { loggedIn: installed && (deps.grokLoggedIn?.() ?? false), loginCompleted: grokAttempt?.completed() ?? false } : {}) }
      }) }
  }
  async function check() {
    const g = await deps.checkGuard()
    if (!g.safe || g.source !== 'bx' || !deps.guard().enabled) throw new Error('network_unprotected')
  }
  async function plan(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'action')) throw new Error('invalid_setup_request')
    const b = body as Record<string, unknown>
    const id = cliSetupId(b.provider), action = cliSetupAction(b.action)
    await check()
    if (id === 'grok') deps.prepareGrokHome?.()
    const binary = deps.binary(id)
    const p = cliSetupPlan(id, action, deps.stateDir, deps.platform, !!binary, binary ?? undefined)
    if (id === 'grok') {
      grokAttempt?.dispose()
      grokAttempt = deps.beginLogin?.()
      if (grokAttempt) p.script += '\n' + grokAttempt.command + '\n'
    }
    return { ok: true, ...p }
  }
  return { snapshot, plan, check }
}
export type CliSetup = ReturnType<typeof makeCliSetup>
