/**
 * 版本号的**接缝守卫**。
 *
 * 2026-09-22 之前,同一个产品的版本号有四份各说各话:
 *   · `apps/desktop/src-tauri/tauri.conf.json` = 1.6.6 —— 发版真正认的那个
 *     (publish-update.ts、desktop.yml、Tauri 自动更新都读它)
 *   · 根 `package.json` = 0.6.4 —— `wechat-cc --version` 与 daemon 健康输出显示的那个
 *   · `apps/desktop/package.json` = 0.5.18 —— 没有任何人读它的 version
 *   · `src/core/acp-agent-provider.ts` = 硬编码 `'0.6.4'` —— 发给 ACP 执行者的 clientInfo
 *
 * 化石版本号不只是难看:`self deploy` 的健康门打印的就是 `--version` 的输出,
 * 而它两次发版之间从不变 —— 部署完打出同一个数字,看不出新构建有没有真的起来。
 *
 * 这些断言不测逻辑,测的是「这几处还对得上同一个数」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION, VERSION_LINE } from '../src/lib/app-version'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8')) as { version?: string }
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

describe('四处版本号对得上', () => {
  const tauri = readJson('apps', 'desktop', 'src-tauri', 'tauri.conf.json').version

  it('tauri.conf 是发版号,根 package.json 必须跟它一致(--version 显示的就是后者)', () => {
    expect(readJson('package.json').version).toBe(tauri)
  })

  it('apps/desktop/package.json 也跟着,别留第三个数', () => {
    expect(readJson('apps', 'desktop', 'package.json').version).toBe(tauri)
  })

  it('APP_VERSION 就是那个号(代码侧的唯一入口)', () => {
    expect(APP_VERSION).toBe(tauri)
  })
})

describe('版本号的两种用法别混', () => {
  it('APP_VERSION 是纯 semver —— 插件闸门要拿它做比较(registry 的 requires wechat-cc >= X)', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('VERSION_LINE 才带构建标识,给人看', () => {
    expect(VERSION_LINE).toMatch(/^\d+\.\d+\.\d+ \(.+\)$/)
  })

  it('clientInfo 里不许写死版本字面量 —— 第一版守卫只盯了一个文件,结果漏了另外四处', () => {
    // 2026-09-22 实录:acp-agent-provider、acp-workbench-provider.test、codex-app-server、
    // codex-model-catalog、codex-history-rpc 五处各自写着 version: '0.6.4'(发版早已到 1.6.x)。
    // 只盯其中一个的守卫等于没守;按「我们对外自称是谁」这个语义扫,而不是扫所有 semver
    // 字面量 —— MCP server 自己的 name/version('0.1.0' 之类)是组件的号,不是产品版本。
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
        const body = readFileSync(join(ROOT, rel), 'utf8')
        for (const m of body.matchAll(/clientInfo\s*:\s*\{[^}]*\}/g)) {
          if (/version\s*:\s*['"]\d/.test(m[0])) offenders.push(`${rel}: ${m[0].slice(0, 80)}`)
        }
      }
    }
    walk('src')
    expect(offenders, '改成从 src/lib/app-version.ts 取 APP_VERSION').toEqual([])
  })
})

describe('构建标识必须真的被注入', () => {
  it('build-sidecar 用 --define 把 git 短 sha 钉进产物(漏了它,--version 又变回一个永不变的数)', () => {
    const src = read('apps', 'desktop', 'scripts', 'build-sidecar.ts')
    expect(src).toContain('__BUILD_SHA__')
    expect(src).toContain('--define')
    expect(src).toContain('rev-parse')
  })
})
