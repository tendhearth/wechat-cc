import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPlatformsFromDir, localMacUpdaterTarball, macProductName, mergePlatforms, unsignedUpdaterArtifacts } from './publish-update.platforms'

const dir = (files: string[]): string => {
  const d = mkdtempSync(join(tmpdir(), 'pub-'))
  for (const f of files) writeFileSync(join(d, f), 'x')
  return d
}

describe('collectPlatformsFromDir —— 让 CI 一次发全平台', () => {
  it('两个平台都齐 → 都收', () => {
    const d = dir(['wechat-cc.app.tar.gz', 'wechat-cc.app.tar.gz.sig',
                   'wechat-cc_1.6.6_x64-setup.exe', 'wechat-cc_1.6.6_x64-setup.exe.sig'])
    const got = collectPlatformsFromDir(d, '1.6.6').map(p => [p.platformKey, p.artifactName])
    expect(got).toEqual([
      ['darwin-aarch64', 'wechat-cc_1.6.6_darwin-aarch64.app.tar.gz'],
      ['windows-x86_64', 'wechat-cc_1.6.6_windows-x86_64-setup.exe'],
    ])
  })

  it('**没有 .sig 的一律跳过** —— 无签名的条目会让客户端拒绝更新', () => {
    // 这正是 desktop-v1.6.6 第一次出包时的状态:包都在,签名被上一层过滤掉了。
    const d = dir(['wechat-cc.app.tar.gz'])
    expect(collectPlatformsFromDir(d, '1.6.6')).toEqual([])
  })

  it('只有一个平台也能发(另一台还没构建完的场景)', () => {
    const d = dir(['wechat-cc.app.tar.gz', 'wechat-cc.app.tar.gz.sig'])
    expect(collectPlatformsFromDir(d, '1.6.6').map(p => p.platformKey)).toEqual(['darwin-aarch64'])
  })

  it('版本号不匹配的 exe 不会被误认', () => {
    const d = dir(['wechat-cc_1.6.5_x64-setup.exe', 'wechat-cc_1.6.5_x64-setup.exe.sig'])
    expect(collectPlatformsFromDir(d, '1.6.6')).toEqual([])
  })

  it('dmg/msi/deb 不进自动更新(它们是给新用户手动装的)', () => {
    const d = dir(['wechat-cc_1.6.6_aarch64.dmg', 'wechat-cc_1.6.6_amd64.deb', 'wechat-cc_1.6.6_x64_en-US.msi'])
    expect(collectPlatformsFromDir(d, '1.6.6')).toEqual([])
  })
})

describe('1.7.5 改名:macOS updater 包换了文件名,latest.json 的形状不变(老客户端只认 url)', () => {
  it('本地构建的 `Tendhearth CC.app.tar.gz` → darwin-aarch64,R2 对象名还是 wechat-cc_<ver>_darwin-aarch64.app.tar.gz', () => {
    const d = dir(['Tendhearth CC.app.tar.gz', 'Tendhearth CC.app.tar.gz.sig'])
    const got = collectPlatformsFromDir(d, '1.7.5')
    expect(got.map(p => [p.platformKey, p.artifactName])).toEqual([['darwin-aarch64', 'wechat-cc_1.7.5_darwin-aarch64.app.tar.gz']])
    expect(got[0]!.artifactPath.endsWith('Tendhearth CC.app.tar.gz')).toBe(true)
  })

  it('GitHub Release 把空格换成点:CI 下载回来的 `Tendhearth.CC.app.tar.gz` 也认', () => {
    const d = dir(['Tendhearth.CC.app.tar.gz', 'Tendhearth.CC.app.tar.gz.sig', 'wechat-cc_1.7.5_x64-setup.exe', 'wechat-cc_1.7.5_x64-setup.exe.sig'])
    expect(collectPlatformsFromDir(d, '1.7.5').map(p => p.platformKey)).toEqual(['darwin-aarch64', 'windows-x86_64'])
  })

  it('新旧两个名字同时在 ⇒ 拒绝(混了两次构建,挑哪个都可能把旧包发出去)', () => {
    const d = dir(['Tendhearth CC.app.tar.gz', 'Tendhearth CC.app.tar.gz.sig', 'wechat-cc.app.tar.gz', 'wechat-cc.app.tar.gz.sig'])
    expect(() => collectPlatformsFromDir(d, '1.7.5')).toThrow(/ambiguous/)
  })

  it('新名字的包缺 .sig 照样点名', () => {
    expect(unsignedUpdaterArtifacts('/x', ['Tendhearth CC.app.tar.gz'])).toEqual(['Tendhearth CC.app.tar.gz'])
  })

  it('本机单平台发布:先找新名字,回落老名字', () => {
    // 路径用 join 拼,跟实现一样按平台分隔符(Windows CI 上是反斜杠)。
    const oldTar = join('/b', 'wechat-cc.app.tar.gz'), newTar = join('/b', 'Tendhearth CC.app.tar.gz')
    expect(localMacUpdaterTarball('/b', p => p === oldTar)).toBe(oldTar)
    expect(localMacUpdaterTarball('/b', () => true)).toBe(newTar)
    expect(localMacUpdaterTarball('/b', () => false)).toBe(newTar)
  })

  it('dmg 名跟 macOS 的 productName(tauri.macos.conf.json 覆盖基础配置)', () => {
    expect(macProductName({ productName: 'wechat-cc' }, { productName: 'Tendhearth CC' })).toBe('Tendhearth CC')
    expect(macProductName({ productName: 'wechat-cc' }, null)).toBe('wechat-cc')
  })
})

describe('mergePlatforms —— 只保留同版本的旧条目', () => {
  const fresh = { 'darwin-aarch64': { signature: 'new', url: 'u' } }

  it('同版本 → 其它平台的条目留着(它们还是这一版的)', () => {
    const r = mergePlatforms({ version: '1.6.6', platforms: { 'windows-x86_64': { signature: 'w', url: 'wu' } } }, '1.6.6', fresh)
    expect(Object.keys(r).sort()).toEqual(['darwin-aarch64', 'windows-x86_64'])
  })

  it('**版本不同 → 旧条目全丢** —— 留着会让那个平台的用户在新旧之间反复更新', () => {
    const r = mergePlatforms({ version: '1.6.5', platforms: { 'windows-x86_64': { signature: 'w', url: 'wu' } } }, '1.6.6', fresh)
    expect(Object.keys(r)).toEqual(['darwin-aarch64'])
  })

  it('线上还没有 latest.json(首发)', () => {
    expect(mergePlatforms(null, '1.6.6', fresh)).toEqual(fresh)
  })

  it('同平台的新条目覆盖旧的', () => {
    const r = mergePlatforms({ version: '1.6.6', platforms: { 'darwin-aarch64': { signature: 'old', url: 'o' } } }, '1.6.6', fresh)
    expect(r['darwin-aarch64']!.signature).toBe('new')
  })
})

describe('unsignedUpdaterArtifacts —— 缺签名要说出来,不能静默跳过', () => {
  it('点名没有 .sig 的 updater 产物', () => {
    expect(unsignedUpdaterArtifacts('/x', ['wechat-cc.app.tar.gz', 'wechat-cc_1.6.6_x64-setup.exe', 'wechat-cc_1.6.6_x64-setup.exe.sig']))
      .toEqual(['wechat-cc.app.tar.gz'])
  })
  it('都带签名 → 空', () => {
    expect(unsignedUpdaterArtifacts('/x', ['a.app.tar.gz', 'a.app.tar.gz.sig'])).toEqual([])
  })
  it('非 updater 产物不参与(dmg 本来就没签名)', () => {
    expect(unsignedUpdaterArtifacts('/x', ['wechat-cc_1.6.6_aarch64.dmg'])).toEqual([])
  })
})
