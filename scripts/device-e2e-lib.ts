/**
 * device-e2e-lib — `scripts/device-e2e.ts`(Tendhearth iPhone 真机全自动验收)的纯函数部分。无 IO,单测在旁边。
 */

/** XCUITest 步骤往 stdout 打的 `E2E_OUT 键=值`(native/ios-e2e/DeviceE2ETests.swift out())。同键后出现的为准。 */
export function parseE2EOut(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/)) {
    const m = /E2E_OUT ([a-z0-9_]+)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!.trimEnd()
  }
  return out
}

/**
 * 桌面「连接手机」给的 https 配对链接 ⇒ 开发构建认的自定义 scheme 形状(apps/app/src/net/system-link.ts:
 * `tendhearth://<主机>/pset/#…` 只在开发构建里认,与通用链接走同一条 JS 链路)。不是 /pset 链接 ⇒ null。
 */
export function customSchemeLink(url: string): string | null {
  const m = /^https:\/\/([a-z0-9.-]+)\/pset\/?(#.*)$/i.exec(url.trim())
  return m ? `tendhearth://${m[1]}/pset/${m[2]}` : null
}

export function newDeviceIds(before: Array<{ id: string }>, after: Array<{ id: string }>): string[] {
  const had = new Set(before.map(d => d.id))
  return after.map(d => d.id).filter(id => !had.has(id))
}

/** `~/.private_keys/app-store-connect.env`:`export K=V` / `K=V` / `K="V"`,`#` 注释,展开 `~` 与 `$HOME`。只取形如变量名的键。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    const home = process.env.HOME ?? '~'
    out[m[1]!] = v.replace(/^~(?=\/)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home)
  }
  return out
}

/** xcodebuild / devicectl 的输出里,哪些是「要主人在手机上动一下」的。命中 ⇒ 报告这一句,不去猜。 */
export function humanBlocker(output: string): string | null {
  const rules: Array<[RegExp, string]> = [
    [/Developer Mode (is )?disabled|enable Developer Mode/i, '手机上打开「设置 → 隐私与安全性 → 开发者模式」并按提示重启'],
    [/device is (passcode )?locked|is locked|Unlock .* to Continue|The device is locked/i, '解锁手机并保持亮屏(设置 → 显示与亮度 → 自动锁定 → 永不,跑完再改回)'],
    [/not paired|Trust this computer|pairing (is )?(not|in)/i, '手机上点「信任这台电脑」(或重新插线后在手机上确认信任)'],
    // iOS 17+:测试 runner 起来时手机弹「Enable UI Automation · 使用触控 ID 以继续使用 XCTest」,没人验证就超时取消
    [/failed to initialize for UI testing|com\.apple\.LocalAuthentication|Enable UI Automation/i, '手机上弹了「Enable UI Automation」:验证一次触控 ID / 密码(或预先在「设置 → 开发者 → 启用 UI 自动化」打开),再重跑'],
    [/untrusted developer|Untrusted Developer|is not trusted/i, '手机上「设置 → 通用 → VPN 与设备管理」信任开发者证书'],
  ]
  for (const [re, msg] of rules) if (re.test(output)) return msg
  return null
}

export interface StepRecord { name: string; ok: boolean; ms: number; detail?: string; screenshot?: string; outs?: Record<string, string> }

export function renderReport(r: { ok: boolean; startedAt: string; udid: string; steps: StepRecord[]; blocker?: string | null; outDir: string }): string {
  const lines = [
    `# Tendhearth 真机验收 — ${r.ok ? 'PASS' : 'FAIL'}`,
    '',
    `- 开始:${r.startedAt}`,
    `- 设备:${r.udid}`,
    `- 目录:${r.outDir}`,
    ...(r.blocker ? [`- **要主人动手**:${r.blocker}`] : []),
    '',
    '| 步骤 | 结果 | 用时 | 说明 |',
    '|---|---|---|---|',
    ...r.steps.map(s => `| ${s.name} | ${s.ok ? '✓' : '✗'} | ${(s.ms / 1000).toFixed(1)}s | ${(s.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')}${s.screenshot ? ` (截图 ${s.screenshot})` : ''} |`),
    '',
  ]
  return lines.join('\n')
}
