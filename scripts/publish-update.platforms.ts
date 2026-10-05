/**
 * publish-update 的**平台收集**部分,抽成纯函数以便单测 + 让 CI 一次发全平台。
 *
 * WHY(2026-09-03):此前 `publish-update.ts` 一次只发**当前这台机器的平台**
 * (注释原话:「Windows 构建在 Windows 机器上跑同一脚本即可补上自己的平台」)。
 * 于是要让三平台用户都能自动更新,得在 Mac 上跑一遍、再去 Windows 上跑一遍,
 * 而且两边都要先本地 build —— 尽管 CI 刚刚已经把三个平台都构建好了。
 *
 * 这就是为什么 v1.4.1→v1.6.2 全是「本地手工构建、手动传」:**流程在逼人
 * 手工做**。给它一个「从一个目录里认出所有平台」的入口,CI 就能在
 * `release: published` 时一次发全。
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface PlatformArtifact {
  /** latest.json 里的键,如 darwin-aarch64 / windows-x86_64。 */
  platformKey: string
  artifactPath: string
  sigPath: string
  /** 上传到 R2 时的对象名。 */
  artifactName: string
}

/**
 * 从一个**扁平的产物目录**里认出所有可发布的平台。
 *
 * 只认 updater 产物(带 `.sig` 的那种)——dmg/msi/deb/rpm 是给新用户手动
 * 装的,不进自动更新。**没有 .sig 的一律跳过**:latest.json 里的条目必须
 * 带签名,否则客户端会拒绝这次更新,而那种失败在用户侧长得像「更新坏了」。
 */
/**
 * macOS updater 包可能的文件名(2026-10-04,1.7.5 改名迁移)。
 *
 * tauri 按 productName 给包命名,1.7.5 起 macOS 的 productName 是 `Tendhearth CC`
 * (tauri.macos.conf.json)⇒ 本地产物叫 `Tendhearth CC.app.tar.gz`;GitHub Release 上传
 * 时会把文件名里的空格换成 `.`(REST API「GitHub renames asset filenames that have special
 * characters」)⇒ CI 从 release 下载回来的是 `Tendhearth.CC.app.tar.gz`。老名字留着给回滚 /
 * 补发 1.7.4 及以前。
 *
 * 老客户端不看这里的文件名:它们只读 latest.json 里的 url,而上传到 R2 的对象名
 * (artifactName)一直是 `wechat-cc_<ver>_darwin-aarch64.app.tar.gz`;tar 包顶层目录名
 * 在安装时被丢掉(tauri-plugin-updater 2.10.1 updater.rs:1238 `iter().skip(1)`),内容解进
 * 正在运行的那个 .app 路径 —— 见 docs/maintainer/app-rename-migration.md。
 */
export const MAC_UPDATER_TARBALLS = ['Tendhearth CC.app.tar.gz', 'Tendhearth.CC.app.tar.gz', 'wechat-cc.app.tar.gz'] as const

export function collectPlatformsFromDir(dir: string, version: string): PlatformArtifact[] {
  const out: PlatformArtifact[] = []
  const signed = (file: string) => existsSync(join(dir, file)) && existsSync(join(dir, `${file}.sig`))
  const macs = MAC_UPDATER_TARBALLS.filter(signed)
  // 两个名字都在 = 目录里混了两次构建;挑哪个都可能把旧包发出去,宁可停下。
  if (macs.length > 1) throw new Error(`ambiguous macOS updater artifacts in ${dir}: ${macs.join(', ')}`)
  const candidates: Array<{ file: string; platformKey: string; suffix: string }> = [
    ...macs.map(file => ({ file, platformKey: 'darwin-aarch64', suffix: '.app.tar.gz' })),
    { file: `wechat-cc_${version}_x64-setup.exe`, platformKey: 'windows-x86_64', suffix: '-setup.exe' },
  ]
  for (const c of candidates) {
    const artifactPath = join(dir, c.file)
    const sigPath = `${artifactPath}.sig`
    if (!existsSync(artifactPath) || !existsSync(sigPath)) continue
    out.push({
      platformKey: c.platformKey,
      artifactPath,
      sigPath,
      // R2 对象名不随 productName 变:老客户端的 latest.json 一直指这个形状。
      artifactName: `wechat-cc_${version}_${c.platformKey}${c.suffix}`,
    })
  }
  return out
}

/**
 * 合并 latest.json 的平台表。
 *
 * **只保留同版本的旧条目** —— 版本不同的残留会让那个平台的用户在新旧之间
 * 反复更新(updater loop)。这条规则原本写在 publish-update.ts 里,抽出来
 * 是为了让它有测试。
 */
export function mergePlatforms(
  existing: { version?: string; platforms?: Record<string, { signature: string; url: string }> } | null,
  version: string,
  fresh: Record<string, { signature: string; url: string }>,
): Record<string, { signature: string; url: string }> {
  const keep = existing && existing.version === version ? (existing.platforms ?? {}) : {}
  return { ...keep, ...fresh }
}

/** 目录里那些**没有签名**的 updater 产物 —— 调用方该把它们说出来,而不是静默跳过。 */
export function unsignedUpdaterArtifacts(dir: string, files: string[]): string[] {
  const set = new Set(files.map(f => basename(f)))
  return files
    .map(f => basename(f))
    .filter(n => (n.endsWith('.app.tar.gz') || n.endsWith('-setup.exe')) && !set.has(`${n}.sig`))
}

/**
 * 本机 macOS 构建出来的 updater 包在哪(publish-update.ts 的单平台路径)。按 MAC_UPDATER_TARBALLS
 * 的顺序找第一个存在的;都不在 ⇒ 返回新名字的路径(让报错信息指向该有的那个文件)。
 */
export function localMacUpdaterTarball(bundleMacosDir: string, exists: (p: string) => boolean = existsSync): string {
  for (const f of MAC_UPDATER_TARBALLS) {
    const p = join(bundleMacosDir, f)
    if (exists(p)) return p
  }
  return join(bundleMacosDir, MAC_UPDATER_TARBALLS[0])
}

/** macOS 生效的 productName:tauri.macos.conf.json 覆盖 tauri.conf.json(JSON merge patch)。 */
export function macProductName(base: { productName?: string }, mac: { productName?: string } | null): string {
  return mac?.productName ?? base.productName ?? 'wechat-cc'
}
