import { describe, it, expect } from 'vitest'
import { forwarderAction, forwarderScript, planLaunchAgentRepair, staleHookProgram, unsafeSelfLocation } from './app-relocation'
import { runServiceRepair, type ServiceRepairDeps } from './service-repair'
import { ServiceRepairOutput } from './schema'

const OLD_APP = '/Applications/wechat-cc.app'
const NEW_APP = '/Applications/Tendhearth CC.app'
const SELF = { mainBinary: `${NEW_APP}/Contents/MacOS/Tendhearth CC`, sidecar: `${NEW_APP}/Contents/MacOS/tendhearth-cc-cli` }

/** 1.7.3 真机上那份 plist 的形状(plutil -p 核对过)。 */
function plist(program: string[], wd = `${OLD_APP}/Contents/MacOS`, pluginsDir?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-cc.daemon</string>
  <key>ProgramArguments</key><array>
${program.map(a => `    <string>${a.replace(/&/g, '&amp;')}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key><dict><key>WECHAT_CC_SUPERVISED</key><string>1</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>${pluginsDir ? `<key>WECHAT_CC_BUNDLED_PLUGINS_DIR</key><string>${pluginsDir}</string>` : ''}</dict>
  <key>WorkingDirectory</key><string>${wd}</string>
  <key>StandardErrorPath</key><string>/Users/u/.claude/channels/wechat/launchd.err.log</string>
  <key>KeepAlive</key><true/>
</dict></plist>
`
}

const OLD_PROGRAM = [`${OLD_APP}/Contents/MacOS/wechat_cc_desktop`, '--daemon', 'run', '--dangerously']

describe('planLaunchAgentRepair —— 旧目标不存在才改', () => {
  it('原地更新 + 改名之后:主二进制 / WorkingDirectory / 包内插件目录全部换到新包,参数和别的键原样', () => {
    const p = planLaunchAgentRepair({
      plistXml: plist(OLD_PROGRAM, `${OLD_APP}/Contents/MacOS`, `${OLD_APP}/Contents/Resources/plugins`),
      self: SELF,
      exists: () => false,
    })
    expect(p.action).toBe('rewrite')
    if (p.action !== 'rewrite') return
    expect(p.fromApp).toBe(OLD_APP)
    expect(p.toApp).toBe(NEW_APP)
    expect(p.toProgram).toBe(SELF.mainBinary)
    expect(p.xml).toContain(`<string>${NEW_APP}/Contents/MacOS/Tendhearth CC</string>`)
    expect(p.xml).toContain('<string>--daemon</string>')
    expect(p.xml).toContain('<string>--dangerously</string>')
    expect(p.xml).toContain(`<key>WorkingDirectory</key><string>${NEW_APP}/Contents/MacOS</string>`)
    expect(p.xml).toContain(`<string>${NEW_APP}/Contents/Resources/plugins</string>`)
    expect(p.xml).toContain('<string>/Users/u/.claude/channels/wechat/launchd.err.log</string>')
    expect(p.xml).not.toContain('wechat-cc.app')
    // label 不变(TCC / launchctl 目标都认它)
    expect(p.xml).toContain('<string>com.wechat-cc.daemon</string>')
  })

  it('只在原地更新、改名被拦下时:同一个 .app,主二进制换成新名字', () => {
    const self = { mainBinary: `${OLD_APP}/Contents/MacOS/Tendhearth CC`, sidecar: `${OLD_APP}/Contents/MacOS/tendhearth-cc-cli` }
    const p = planLaunchAgentRepair({ plistXml: plist(OLD_PROGRAM), self, exists: () => false })
    expect(p.action).toBe('rewrite')
    if (p.action === 'rewrite') {
      expect(p.toProgram).toBe(self.mainBinary)
      expect(p.xml).toContain(`<key>WorkingDirectory</key><string>${OLD_APP}/Contents/MacOS</string>`)
    }
  })

  it('旧目标还在 ⇒ 不抢(那是另一份合法安装,比如开发包正指着它)', () => {
    expect(planLaunchAgentRepair({ plistXml: plist(OLD_PROGRAM), self: SELF, exists: () => true }))
      .toEqual({ action: 'none', reason: 'points_elsewhere' })
  })

  it('已经指着自己 ⇒ ok', () => {
    expect(planLaunchAgentRepair({ plistXml: plist([SELF.mainBinary, '--daemon', 'run']), self: SELF, exists: () => true }))
      .toEqual({ action: 'none', reason: 'ok' })
  })

  it('开发模式 plist(bun + cli.ts)不归它管', () => {
    expect(planLaunchAgentRepair({ plistXml: plist(['/opt/homebrew/bin/bun', '/repo/cli.ts', 'run']), self: SELF, exists: () => false }))
      .toEqual({ action: 'none', reason: 'not_app_bundle' })
  })

  it('没有 plist / 不是打包版 ⇒ 不动', () => {
    expect(planLaunchAgentRepair({ plistXml: null, self: SELF, exists: () => false }).reason).toBe('no_launchagent')
    expect(planLaunchAgentRepair({ plistXml: plist(OLD_PROGRAM), self: { mainBinary: null, sidecar: null }, exists: () => false }).reason).toBe('not_packaged')
  })

  it('自己跑在 cargo target / 隔离路径 / dmg 里 ⇒ 绝不把主人的 LaunchAgent 指过来', () => {
    for (const app of [
      '/Users/u/wechat-cc/apps/desktop/src-tauri/target/release/bundle/macos/Tendhearth CC.app',
      '/private/var/folders/x/T/AppTranslocation/ABC/d/Tendhearth CC.app',
      '/Volumes/Tendhearth CC/Tendhearth CC.app',
      '/private/tmp/scratch/cargo-target/release/bundle/macos/Tendhearth CC.app',
    ]) {
      const self = { mainBinary: `${app}/Contents/MacOS/Tendhearth CC`, sidecar: `${app}/Contents/MacOS/tendhearth-cc-cli` }
      expect(planLaunchAgentRepair({ plistXml: plist(OLD_PROGRAM), self, exists: () => false }).reason).toBe('self_location_unsafe')
    }
    expect(unsafeSelfLocation('/Applications/Tendhearth CC.app')).toBeNull()
    expect(unsafeSelfLocation('/Users/u/Applications/Tendhearth CC.app')).toBeNull()
  })

  it('09-04 之前的老形状(直接指 sidecar)⇒ 保持形状,换成自己的 sidecar', () => {
    const p = planLaunchAgentRepair({ plistXml: plist([`${OLD_APP}/Contents/MacOS/wechat-cc-cli`, 'run']), self: SELF, exists: () => false })
    expect(p.action === 'rewrite' && p.toProgram).toBe(SELF.sidecar)
  })

  it('路径里的 & 等 XML 字符来回转义不丢', () => {
    const app = '/Users/u/A&B/wechat-cc.app'
    const p = planLaunchAgentRepair({ plistXml: plist([`${app}/Contents/MacOS/wechat_cc_desktop`, '--daemon'], `${app}/Contents/MacOS`.replace(/&/g, '&amp;')), self: SELF, exists: () => false })
    expect(p.action === 'rewrite' && p.fromApp).toBe(app)
  })
})

describe('staleHookProgram —— 终端 hook 指向不存在的 sidecar ⇒ 换成自己', () => {
  const old = `"${OLD_APP}/Contents/MacOS/wechat-cc-cli" hook claude`
  it('旧 sidecar 不在了 ⇒ 返回旧路径', () => {
    expect(staleHookProgram(old, SELF.sidecar, () => false)).toBe(`${OLD_APP}/Contents/MacOS/wechat-cc-cli`)
  })
  it('旧路径还在 / 已经是自己 / 源码模式 / 没装 ⇒ null', () => {
    expect(staleHookProgram(old, SELF.sidecar, () => true)).toBeNull()
    expect(staleHookProgram(`"${SELF.sidecar}" hook claude`, SELF.sidecar, () => false)).toBeNull()
    expect(staleHookProgram('"/opt/homebrew/bin/bun" "/repo/cli.ts" hook claude', SELF.sidecar, () => false)).toBeNull()
    expect(staleHookProgram(null, SELF.sidecar, () => false)).toBeNull()
  })
})

describe('转发脚本 ~/.local/bin/wechat-cc —— 命令行入口不随 app 改名而断', () => {
  it('内容:exec 当前 sidecar,路径带空格要整段引起来', () => {
    expect(forwarderScript(SELF.sidecar)).toBe(`#!/bin/sh\n# wechat-cc forwarder — managed by Tendhearth CC (\`wechat-cc service repair\`)\nexec '${SELF.sidecar}' "$@"\n`)
  })
  it('不存在 ⇒ 写;自家的、目标变了 ⇒ 重写;自家的、目标一致 ⇒ ok;别人的同名文件 ⇒ 不碰', () => {
    expect(forwarderAction(null, SELF.sidecar)).toBe('write')
    expect(forwarderAction(forwarderScript('/old/wechat-cc-cli'), SELF.sidecar)).toBe('write')
    expect(forwarderAction(forwarderScript(SELF.sidecar), SELF.sidecar)).toBe('ok')
    expect(forwarderAction('#!/bin/sh\nexec bun /repo/cli.ts "$@"\n', SELF.sidecar)).toBe('foreign')
  })
})

describe('runServiceRepair —— 三样东西一次改完,输出过 schema', () => {
  function harness(over: Partial<ServiceRepairDeps> = {}, files: Record<string, string> = {}) {
    const fs = new Map(Object.entries(files))
    const writes: Array<[string, number | undefined]> = []
    const hooksInstalled: string[] = []
    let reloads = 0
    const deps: ServiceRepairDeps = {
      platform: 'darwin',
      self: SELF,
      plistPath: '/Users/u/Library/LaunchAgents/com.wechat-cc.daemon.plist',
      forwarderPath: '/Users/u/.local/bin/wechat-cc',
      hookFiles: [{ source: 'claude', file: '/Users/u/.claude/settings.json' }, { source: 'codex', file: '/Users/u/.codex/hooks.json' }],
      readFile: p => fs.get(p) ?? null,
      exists: p => fs.has(p),
      writeFileAtomic: (p, c, mode) => { fs.set(p, c); writes.push([p, mode]) },
      hookStatus: (_f, source) => source === 'claude'
        ? { installed: true, command: `"${OLD_APP}/Contents/MacOS/wechat-cc-cli" hook claude` }
        : { installed: false, command: null },
      installHook: (_f, source) => { hooksInstalled.push(source) },
      reloadLaunchAgent: () => { reloads++; return null },
      dryRun: false,
      reload: true,
      ...over,
    }
    return { deps, fs, writes, hooksInstalled, reloads: () => reloads }
  }

  it('旧包路径都不在了:改 plist(0600)+ 重载 + 改 claude hook + 写转发脚本(0755)', () => {
    const h = harness({}, { '/Users/u/Library/LaunchAgents/com.wechat-cc.daemon.plist': plist(OLD_PROGRAM) })
    const r = runServiceRepair(h.deps)
    expect(r.launchAgent).toMatchObject({ action: 'rewrite', reloaded: true, to: SELF.mainBinary })
    expect(h.reloads()).toBe(1)
    expect(h.writes).toContainEqual(['/Users/u/Library/LaunchAgents/com.wechat-cc.daemon.plist', 0o600])
    expect(h.writes).toContainEqual(['/Users/u/.local/bin/wechat-cc', 0o755])
    expect(h.hooksInstalled).toEqual(['claude'])
    expect(r.hooks).toEqual([{ source: 'claude', from: `${OLD_APP}/Contents/MacOS/wechat-cc-cli`, to: SELF.sidecar }])
    expect(ServiceRepairOutput.safeParse({ ok: true, action: 'repair', dryRun: false, ...r }).success).toBe(true)
  })

  it('正常启动(plist 已经指着自己)⇒ 不写 plist、不重载 daemon', () => {
    const h = harness({}, {
      '/Users/u/Library/LaunchAgents/com.wechat-cc.daemon.plist': plist([SELF.mainBinary, '--daemon', 'run'], `${NEW_APP}/Contents/MacOS`),
      [SELF.mainBinary]: 'x',
      [`${OLD_APP}/Contents/MacOS/wechat-cc-cli`]: 'x',
      '/Users/u/.local/bin/wechat-cc': forwarderScript(SELF.sidecar),
    })
    const r = runServiceRepair(h.deps)
    expect(r.launchAgent).toMatchObject({ action: 'none', reason: 'ok', reloaded: false })
    expect(h.reloads()).toBe(0)
    expect(h.writes).toEqual([])
    expect(r.forwarder.action).toBe('ok')
  })

  it('--no-reload:只写文件;dry-run:什么都不写', () => {
    const files = { '/Users/u/Library/LaunchAgents/com.wechat-cc.daemon.plist': plist(OLD_PROGRAM) }
    const a = harness({ reload: false }, files)
    expect(runServiceRepair(a.deps).launchAgent.reloaded).toBe(false)
    expect(a.reloads()).toBe(0)
    const b = harness({ dryRun: true }, files)
    const r = runServiceRepair(b.deps)
    expect(r.launchAgent.action).toBe('rewrite')
    expect(b.writes).toEqual([])
    expect(b.hooksInstalled).toEqual([])
  })

  it('非 macOS:LaunchAgent / 转发脚本都不碰', () => {
    const h = harness({ platform: 'win32' })
    const r = runServiceRepair(h.deps)
    expect(r.launchAgent.action).toBe('none')
    expect(r.forwarder.action).toBe('skipped')
  })
})
