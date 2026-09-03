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
export function collectPlatformsFromDir(dir: string, version: string): PlatformArtifact[] {
  const out: PlatformArtifact[] = []
  const candidates: Array<{ file: string; platformKey: string; suffix: string }> = [
    { file: 'wechat-cc.app.tar.gz', platformKey: 'darwin-aarch64', suffix: '.app.tar.gz' },
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
