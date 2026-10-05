/**
 * service-repair.ts — `wechat-cc service repair`:把指向旧 app 路径的三样东西改到自己身上。
 *
 *   1. LaunchAgent plist(ProgramArguments / WorkingDirectory / 包内的环境变量路径),
 *      改完 bootout + bootstrap 重新加载 —— 只改文件不重载没用,launchd 照着已加载的
 *      旧定义 respawn;
 *   2. 终端 claude / codex 的 hook 命令行;
 *   3. `~/.local/bin/wechat-cc` 转发脚本(一条不随 app 改名 / 换位置而断的命令行入口)。
 *
 * 谁调它:桌面 app 每次启动在后台调一次(apps/desktop/src-tauri/src/bundle_migrate.rs),
 * app 把自己从 `wechat-cc.app` 改名成 `Tendhearth CC.app` 之后同步调一次。判定见
 * app-relocation.ts:**旧目标不存在才改**,所以正常启动时它什么都不做。
 *
 * 重载 = daemon 重启。只在旧目标已经不存在时发生 —— 那时正在跑的 daemon 是旧包的进程,
 * 一旦退出 launchd 就拉不起来了,早重载早安全。
 */
import { planLaunchAgentRepair, unsafeSelfLocation, staleHookProgram, forwarderAction, forwarderScript, type LaunchAgentRepairPlan, type SelfLocation } from './app-relocation'

export interface ServiceRepairDeps {
  platform: NodeJS.Platform
  self: SelfLocation
  /** ~/Library/LaunchAgents/com.wechat-cc.daemon.plist */
  plistPath: string
  /** ~/.local/bin/wechat-cc */
  forwarderPath: string
  hookFiles: Array<{ source: 'claude' | 'codex'; file: string }>
  readFile: (p: string) => string | null
  exists: (p: string) => boolean
  /** 原子写(tmp + rename),mode 可选。 */
  writeFileAtomic: (p: string, content: string, mode?: number) => void
  hookStatus: (file: string, source: 'claude' | 'codex') => { installed: boolean; command: string | null }
  installHook: (file: string, source: 'claude' | 'codex', selfSidecar: string) => void
  /** bootout(容忍失败)+ bootstrap + enable + kickstart;返回失败信息或 null。 */
  reloadLaunchAgent: () => string | null
  dryRun: boolean
  reload: boolean
}

export interface ServiceRepairResult {
  launchAgent: { action: LaunchAgentRepairPlan['action']; reason: string; from?: string; to?: string; reloaded: boolean; reloadError?: string }
  hooks: Array<{ source: 'claude' | 'codex'; from: string; to: string }>
  forwarder: { path: string; action: 'write' | 'ok' | 'foreign' | 'skipped' }
}

export function runServiceRepair(deps: ServiceRepairDeps): ServiceRepairResult {
  // ── 1. LaunchAgent ──
  const plan = deps.platform === 'darwin'
    ? planLaunchAgentRepair({ plistXml: deps.readFile(deps.plistPath), self: deps.self, exists: deps.exists })
    : { action: 'none' as const, reason: 'not_darwin' }
  const launchAgent: ServiceRepairResult['launchAgent'] = { action: plan.action, reason: plan.reason, reloaded: false }
  if (plan.action === 'rewrite') {
    launchAgent.from = plan.fromProgram
    launchAgent.to = plan.toProgram
    if (!deps.dryRun) {
      deps.writeFileAtomic(deps.plistPath, plan.xml, 0o600)
      if (deps.reload) {
        const err = deps.reloadLaunchAgent()
        launchAgent.reloaded = err === null
        if (err) launchAgent.reloadError = err
      }
    }
  }

  // ── 2. hooks ──
  const hooks: ServiceRepairResult['hooks'] = []
  const sidecar = deps.self.sidecar
  if (sidecar) {
    for (const { source, file } of deps.hookFiles) {
      const st = deps.hookStatus(file, source)
      if (!st.installed) continue
      const stale = staleHookProgram(st.command, sidecar, deps.exists)
      if (!stale) continue
      if (!deps.dryRun) deps.installHook(file, source, sidecar)
      hooks.push({ source, from: stale, to: sidecar })
    }
  }

  // ── 3. 转发脚本(只在 macOS 打包版:别的平台 / 源码模式有自己的入口)──
  let forwarder: ServiceRepairResult['forwarder'] = { path: deps.forwarderPath, action: 'skipped' }
  if (deps.platform === 'darwin' && sidecar && deps.self.mainBinary && !unsafeSelfLocation(sidecar)) {
    const action = forwarderAction(deps.readFile(deps.forwarderPath), sidecar)
    if (action === 'write' && !deps.dryRun) deps.writeFileAtomic(deps.forwarderPath, forwarderScript(sidecar), 0o755)
    forwarder = { path: deps.forwarderPath, action }
  }

  return { launchAgent, hooks, forwarder }
}
