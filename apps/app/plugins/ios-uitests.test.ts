import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import base from '../app.json'

const require = createRequire(import.meta.url)
// xcode 库是 @expo/config-plugins 的依赖(本工程没直接依赖它):从 config-plugins 的位置解析
const xcode = require(require.resolve('xcode', { paths: [dirname(require.resolve('@expo/config-plugins/package.json', { paths: [dirname(require.resolve('expo/package.json'))] }))] })) as { project(p: string): any }
const plugin = require('./with-ios-uitests.js') as {
  UI_TARGET: string
  addUiTestTarget(project: any, o: { bundleId: string; teamId: string }): { app: { uuid: string; name: string }; testUuid: string }
  schemeXml(o: { projectFile: string; app: { uuid: string; name: string }; testUuid: string }): string
}
const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'minimal-app.pbxproj')
const unquote = (s: unknown) => String(s).replace(/^"(.*)"$/, '$1')

function load(text = readFileSync(fixture, 'utf8')) {
  const dir = mkdtempSync(join(tmpdir(), 'uitests-'))
  const p = join(dir, 'project.pbxproj')
  writeFileSync(p, text)
  const project = xcode.project(p)
  project.parseSync()
  // 真的 Expo 工程都有这些段;最小夹具没有就补空段(xcode 库不会自己建)
  const o = project.hash.project.objects
  for (const k of ['PBXBuildFile', 'PBXSourcesBuildPhase', 'PBXResourcesBuildPhase', 'PBXFrameworksBuildPhase', 'PBXCopyFilesBuildPhase']) o[k] = o[k] ?? {}
  return { project, p }
}
const targets = (project: any) => Object.entries(project.pbxNativeTargetSection()).filter(([k]) => !k.endsWith('_comment')) as Array<[string, any]>
const depTargets = (project: any, t: any) => (t.dependencies ?? []).map((d: any) => project.hash.project.objects.PBXTargetDependency[d.value]?.target)

const saved = process.env.TENDHEARTH_UITESTS
afterEach(() => { if (saved === undefined) delete process.env.TENDHEARTH_UITESTS; else process.env.TENDHEARTH_UITESTS = saved })

describe('with-ios-uitests(真机验收的 XCUITest target)', () => {
  it('建 UI 测试 target:依赖主 app、主 app 不反过来依赖它(否则 Xcode 报环)、产物是 .xctest、指向主 app', () => {
    const { project, p } = load()
    const { app, testUuid } = plugin.addUiTestTarget(project, { bundleId: 'com.tendhearth.app', teamId: '9Y6JAPDP7A' })
    expect(app.name).toBe('Tendhearth')
    const ui = project.pbxNativeTargetSection()[testUuid]
    expect(unquote(ui.productType)).toBe('com.apple.product-type.bundle.ui-testing')
    expect(depTargets(project, ui)).toEqual([app.uuid])
    expect(depTargets(project, project.pbxNativeTargetSection()[app.uuid])).toEqual([])
    expect(unquote(project.pbxFileReferenceSection()[ui.productReference].path)).toBe('TendhearthUITests.xctest')
    const cfgs = Object.values(project.pbxXCBuildConfigurationSection()).filter((c: any) => c?.buildSettings && unquote(c.buildSettings.PRODUCT_NAME) === 'TendhearthUITests') as any[]
    expect(cfgs).toHaveLength(2)
    for (const c of cfgs) {
      expect(unquote(c.buildSettings.TEST_TARGET_NAME)).toBe('Tendhearth')
      expect(c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.tendhearth.app.uitests')
      expect(c.buildSettings.DEVELOPMENT_TEAM).toBe('9Y6JAPDP7A')
      expect(c.buildSettings.INFOPLIST_FILE).toBeUndefined()
    }
    // 写出去再读回来仍是合法工程;再加一次不重复(重复 prebuild 幂等)
    writeFileSync(p, project.writeSync())
    const again = load(readFileSync(p, 'utf8')).project
    plugin.addUiTestTarget(again, { bundleId: 'com.tendhearth.app', teamId: '9Y6JAPDP7A' })
    expect(targets(again).filter(([, t]) => unquote(t.name) === 'TendhearthUITests')).toHaveLength(1)
  })
  it('scheme:构建主 app,测试 UI target', () => {
    const xml = plugin.schemeXml({ projectFile: 'Tendhearth.xcodeproj', app: { uuid: 'AAA', name: 'Tendhearth' }, testUuid: 'BBB' })
    expect(xml).toContain('BlueprintIdentifier="AAA" BuildableName="Tendhearth.app"')
    expect(xml).toMatch(/<TestableReference skipped="NO">\s*<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="BBB" BuildableName="TendhearthUITests.xctest"/)
  })
  it('只在 TENDHEARTH_UITESTS=1 时接进 app.config.js(平常的 prebuild / EAS 构建没有它)', () => {
    const load = () => { delete require.cache[require.resolve('../app.config.js')]; return require('../app.config.js') as (a: { config: typeof base.expo }) => any }
    delete process.env.TENDHEARTH_UITESTS
    const plain = load()({ config: base.expo })
    expect(JSON.stringify(plain.plugins)).not.toContain('with-ios-uitests')
    expect(plain.extra.e2eBuild).toBeUndefined()
    process.env.TENDHEARTH_UITESTS = '1'
    const c = load()({ config: base.expo })
    expect(c.plugins).toContainEqual(['./plugins/with-ios-uitests', { teamId: '9Y6JAPDP7A' }])
    expect(c.extra.e2eBuild).toBe(true)
  })
})
