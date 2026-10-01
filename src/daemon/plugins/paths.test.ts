/**
 * 内置插件目录的解析(2026-09-30 回归):09-11 起 LaunchAgent 改成拉起打包版
 * daemon,它从此一个插件都找不到 —— 环境变量没人设、`.app` 里只打了 README、
 * 退路 `<MacOS>/plugins` 也不存在,而且全程没有一行日志。这些用例钉住:
 *   ① 只有「真有插件」的目录才算数(只放 README 的空壳不能把后面的候选挡住);
 *   ② 打包版从自己的可执行文件位置找 `Resources/plugins` 与 Tauri 的 `_up_` 路径;
 *   ③ 主人登记在状态目录里的插件来源(`plugins/bundled-source.json`)换 sidecar、
 *      重打 .app 都不丢。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import {
  MANIFEST_FILE,
  dirHasPlugins,
  readPluginsSourcePointer,
  resolveBundledPluginsDir,
  writePluginsSourcePointer,
} from './paths'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wcc-plugin-paths-')) })
afterEach(() => { removeTempDir(root) })

/** 造一个插件根:每个名字一个子目录 + manifest。 */
function pluginsRoot(dir: string, names: string[]): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# bundled\n')
  for (const n of names) {
    mkdirSync(join(dir, n), { recursive: true })
    writeFileSync(join(dir, n, MANIFEST_FILE), JSON.stringify({ name: n }))
  }
  return dir
}

/** 造一个假 .app:返回 sidecar 的路径(`…/Contents/MacOS/wechat-cc-cli`)。 */
function fakeApp(): { exec: string; resources: string } {
  const contents = join(root, 'wechat-cc.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources'), { recursive: true })
  return { exec: join(contents, 'MacOS', 'wechat-cc-cli'), resources: join(contents, 'Resources') }
}

const base = () => ({ env: undefined as string | undefined, stateDir: join(root, 'state'), compiled: true, execPath: join(root, 'nowhere', 'wechat-cc-cli'), sourceRepoRoot: join(root, 'repo') })

describe('dirHasPlugins', () => {
  it('README-only dir does not count', () => {
    expect(dirHasPlugins(pluginsRoot(join(root, 'p'), []))).toBe(false)
  })
  it('a subdir with a manifest counts — also through a symlink (how the owner wires them)', () => {
    const real = pluginsRoot(join(root, 'real'), ['wxvault'])
    const p = join(root, 'p')
    mkdirSync(p)
    symlinkSync(join(real, 'wxvault'), join(p, 'wxvault'))
    expect(dirHasPlugins(p)).toBe(true)
  })
  it('missing dir ⇒ false, never throws', () => {
    expect(dirHasPlugins(join(root, 'nope'))).toBe(false)
  })
})

describe('resolveBundledPluginsDir', () => {
  it('env pointing at a real plugins dir wins', () => {
    const dir = pluginsRoot(join(root, 'envdir'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), env: dir })).toEqual({ dir, via: 'env' })
  })

  it('env pointing at a README-only shell (what Tauri passes today) falls through instead of shadowing', () => {
    const shell = pluginsRoot(join(root, 'shell'), [])
    const app = fakeApp()
    const inApp = pluginsRoot(join(app.resources, 'plugins'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), env: shell, execPath: app.exec })).toEqual({ dir: inApp, via: 'app' })
  })

  it('compiled: finds Contents/Resources/plugins from its own executable', () => {
    const app = fakeApp()
    const dir = pluginsRoot(join(app.resources, 'plugins'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), execPath: app.exec })).toEqual({ dir, via: 'app' })
  })

  it('compiled: finds the Tauri `_up_/_up_/_up_/plugins` layout (resources: ../../../plugins/)', () => {
    const app = fakeApp()
    const dir = pluginsRoot(join(app.resources, '_up_', '_up_', '_up_', 'plugins'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), execPath: app.exec })).toEqual({ dir, via: 'app' })
  })

  it('compiled: README-only `_up_` dir (the shipped 1.7.x layout) + no pointer ⇒ null', () => {
    const app = fakeApp()
    pluginsRoot(join(app.resources, '_up_', '_up_', '_up_', 'plugins'), [])
    expect(resolveBundledPluginsDir({ ...base(), execPath: app.exec })).toBeNull()
  })

  it('the pointer in the state dir is found by a packaged daemon with an empty bundle (the 09-11 regression)', () => {
    const app = fakeApp()
    pluginsRoot(join(app.resources, '_up_', '_up_', '_up_', 'plugins'), [])
    const owner = pluginsRoot(join(root, 'checkout', 'plugins'), ['wxvault', 'wxsearch'])
    const b = base()
    writePluginsSourcePointer(b.stateDir, owner)
    expect(resolveBundledPluginsDir({ ...b, execPath: app.exec })).toEqual({ dir: owner, via: 'pointer' })
  })

  it('pointer is an explicit operator choice: it beats plugins inside the bundle', () => {
    const app = fakeApp()
    pluginsRoot(join(app.resources, 'plugins'), ['wxvault'])
    const owner = pluginsRoot(join(root, 'checkout', 'plugins'), ['wxvault'])
    const b = base()
    writePluginsSourcePointer(b.stateDir, owner)
    expect(resolveBundledPluginsDir({ ...b, execPath: app.exec })?.via).toBe('pointer')
  })

  it('a stale pointer (dir emptied / gone) falls through to the bundle', () => {
    const app = fakeApp()
    const inApp = pluginsRoot(join(app.resources, 'plugins'), ['wxvault'])
    const b = base()
    writePluginsSourcePointer(b.stateDir, join(root, 'gone'))
    expect(resolveBundledPluginsDir({ ...b, execPath: app.exec })).toEqual({ dir: inApp, via: 'app' })
  })

  it('source mode: <repo>/plugins with real plugins', () => {
    const dir = pluginsRoot(join(root, 'repo', 'plugins'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), compiled: false })).toEqual({ dir, via: 'repo' })
  })

  it('source mode in a worktree (README-only plugins/) ⇒ null rather than an empty dir', () => {
    pluginsRoot(join(root, 'repo', 'plugins'), [])
    expect(resolveBundledPluginsDir({ ...base(), compiled: false })).toBeNull()
  })

  it('no stateDir ⇒ pointer is simply not consulted', () => {
    const dir = pluginsRoot(join(root, 'repo', 'plugins'), ['wxvault'])
    expect(resolveBundledPluginsDir({ ...base(), stateDir: undefined, compiled: false })).toEqual({ dir, via: 'repo' })
  })
})

describe('plugins source pointer', () => {
  it('round-trips and is absent by default', () => {
    const s = join(root, 'state')
    expect(readPluginsSourcePointer(s)).toBeNull()
    writePluginsSourcePointer(s, '/x/plugins')
    expect(readPluginsSourcePointer(s)).toBe('/x/plugins')
  })
  it('malformed file ⇒ null', () => {
    const s = join(root, 'state')
    mkdirSync(join(s, 'plugins'), { recursive: true })
    writeFileSync(join(s, 'plugins', 'bundled-source.json'), '{nope')
    expect(readPluginsSourcePointer(s)).toBeNull()
  })
})
