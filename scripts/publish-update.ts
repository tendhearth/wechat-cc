/**
 * publish-update — 发布桌面更新到自托管更新源(方案 A,2026-08-25)。
 *
 * 用法(在 `cd apps/desktop && bun run build` 之后):
 *   bun scripts/publish-update.ts [--notes "一句话更新说明"]
 *
 * 做三件事:
 *  1. 收集本平台的 updater 产物(macOS: wechat-cc.app.tar.gz + .sig)
 *  2. 合并生成 latest.json(保留其它平台已有条目 —— 从线上现拉,
 *     Windows 构建在 Windows 机器上跑同一脚本即可补上自己的平台)
 *  3. 上传到 Cloudflare R2(REST API,token 读 CF_API_TOKEN 环境变量,
 *     否则读 ~/Desktop/cloudflare_key.txt)。token 无效/缺失时降级:
 *     产物 + latest.json 落到 dist-update/ 目录,手动传到任何静态托管。
 *
 * 托管参数在 scripts/update-hosting.json(非机密):bucket/baseUrl。
 * account id 用 token 现查(/accounts),不落盘。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DESKTOP = join(ROOT, 'apps', 'desktop')
const HOSTING_PATH = join(import.meta.dir, 'update-hosting.json')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

interface Hosting { bucket: string; baseUrl: string; keyPrefix: string }
const hosting: Hosting = existsSync(HOSTING_PATH)
  ? JSON.parse(readFileSync(HOSTING_PATH, 'utf8'))
  : { bucket: 'wechat-cc-updates', baseUrl: 'https://dl.tendhearth.com/wechat-cc', keyPrefix: 'wechat-cc' }

const conf = JSON.parse(readFileSync(join(DESKTOP, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { version: string }
const version = conf.version

// ── 1. collect artifacts ────────────────────────────────────────────────
// 默认取本平台构建产物;--platform + --artifact 可覆盖(例:Windows 机器
// 只编译,exe 拉回 Mac 签名后在 Mac 发布 —— Windows 上无法给 tauri 传
// 空密码环境变量,签名固定在 Mac 做)。
const platformKey = arg('--platform') ?? (process.platform === 'darwin'
  ? `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  : process.platform === 'win32' ? 'windows-x86_64' : `linux-${process.arch}`)

let artifactPath: string
let sigPath: string
const artifactOverride = arg('--artifact')
if (artifactOverride) {
  artifactPath = artifactOverride
  sigPath = `${artifactOverride}.sig`
} else if (process.platform === 'darwin') {
  const macosDir = join(DESKTOP, 'src-tauri', 'target', 'release', 'bundle', 'macos')
  artifactPath = join(macosDir, 'wechat-cc.app.tar.gz')
  sigPath = `${artifactPath}.sig`
} else {
  // Windows NSIS: <name>_<version>_x64-setup.exe(.sig)
  const nsisDir = join(DESKTOP, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  artifactPath = join(nsisDir, `wechat-cc_${version}_x64-setup.exe`)
  sigPath = `${artifactPath}.sig`
}
if (!existsSync(artifactPath) || !existsSync(sigPath)) {
  console.error(`找不到 updater 产物:\n  ${artifactPath}\n  ${sigPath}\n先在 apps/desktop 跑:
  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/wechat-cc-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bunx tauri build --bundles app
(dmg 打包器当前有故障,--bundles app 跳过它;签名密码为空但必须显式传)`)
  process.exit(1)
}
const signature = readFileSync(sigPath, 'utf8').trim()
const artifactName = `wechat-cc_${version}_${platformKey}${platformKey.startsWith('darwin') ? '.app.tar.gz' : '-setup.exe'}`
const artifactUrl = `${hosting.baseUrl}/${artifactName}`

// ── 2. merge latest.json (preserve other platforms) ─────────────────────
interface LatestJson {
  version: string
  notes?: string
  pub_date: string
  platforms: Record<string, { signature: string; url: string }>
}
let existing: LatestJson | null = null
try {
  const r = await fetch(`${hosting.baseUrl}/latest.json`, { signal: AbortSignal.timeout(10_000) })
  if (r.ok) existing = await r.json() as LatestJson
} catch { /* first publish / endpoint not live yet */ }

const latest: LatestJson = {
  version,
  notes: arg('--notes') ?? existing?.notes ?? '',
  pub_date: new Date().toISOString(),
  // Other platforms' entries survive ONLY if they were published for the
  // SAME version — stale-version entries would updater-loop users.
  platforms: {
    ...(existing && existing.version === version ? existing.platforms : {}),
    [platformKey]: { signature, url: artifactUrl },
  },
}

// ── 3. upload to R2, else stage locally ─────────────────────────────────
/**
 * R2 令牌来源,按优先级:env → macOS 钥匙串 → 桌面明文文件(遗留)。
 *
 * 钥匙串这一条是 2026-08-31 加的。此前唯一的落盘位置是
 * `~/Desktop/cloudflare_key.txt` —— 一个明文令牌躺在桌面上,而它和更新签名
 * 私钥合起来就是完整的发布权限(签名保证"包是你签的",latest.json 决定
 * "大家该装哪个")。桌面路径保留为兼容回落,但会提示迁移。
 *
 * 存进钥匙串:
 *   security add-generic-password -a "$USER" -s wechat-cc-r2 -w '<token>' -U
 */
function readToken(): string | null {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN.trim()
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', 'wechat-cc-r2', '-w'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout.trim()
  } catch { /* 非 macOS 或钥匙串不可用 —— 回落到下面 */ }
  const f = join(homedir(), 'Desktop', 'cloudflare_key.txt')
  if (existsSync(f)) {
    console.warn(`⚠️  正在从桌面明文文件读 R2 令牌(${f})。建议迁进钥匙串后删掉它:
  security add-generic-password -a "$USER" -s wechat-cc-r2 -w "$(cat '${f}')" -U && rm '${f}'`)
    return readFileSync(f, 'utf8').trim()
  }
  return null
}

async function uploadR2(token: string): Promise<boolean> {
  const H = { Authorization: `Bearer ${token}` }
  const acct = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: H })
  const acctBody = await acct.json() as { success: boolean; result?: Array<{ id: string }> }
  if (!acctBody.success || !acctBody.result?.[0]) {
    console.error('Cloudflare token 无效或没有账户权限 — 降级为本地暂存')
    return false
  }
  const accountId = acctBody.result[0].id
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`
  // ensure bucket (idempotent — 409 already-exists is fine)
  const mk = await fetch(base, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: hosting.bucket }) })
  if (!mk.ok && mk.status !== 409) {
    const t = await mk.text()
    if (!t.includes('already')) { console.error(`R2 bucket 创建失败(${mk.status}): ${t.slice(0, 200)} — 降级为本地暂存`); return false }
  }
  const put = async (key: string, body: Uint8Array | string, type: string) => {
    const r = await fetch(`${base}/${hosting.bucket}/objects/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { ...H, 'content-type': type }, body: body as BodyInit,
    })
    if (!r.ok) throw new Error(`PUT ${key} → ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  await put(`${hosting.keyPrefix}/${artifactName}`, new Uint8Array(readFileSync(artifactPath)), 'application/octet-stream')
  await put(`${hosting.keyPrefix}/latest.json`, JSON.stringify(latest, null, 2), 'application/json')

  // 旧版清理 — 每平台只留最近 KEEP_VERSIONS 版,免费额度(10GB)永远够用。
  try {
    const KEEP_VERSIONS = 3
    const list = await fetch(`${base}/${hosting.bucket}/objects?per_page=1000`, { headers: H })
    const listBody = await list.json() as { success: boolean; result?: Array<{ key: string }> }
    const keys = (listBody.result ?? []).map(o => o.key)
    // key 形如 wechat-cc_<semver>_<platform>(.app.tar.gz|-setup.exe)
    const parsed = keys
      .map(k => { const m = k.match(/wechat-cc_(\d+\.\d+\.\d+)_(.+?)(\.app\.tar\.gz|-setup\.exe)$/); return m ? { key: k, version: m[1]!, platform: m[2]! } : null })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    const byPlatform = new Map<string, typeof parsed>()
    for (const a of parsed) { const arr = byPlatform.get(a.platform) ?? []; arr.push(a); byPlatform.set(a.platform, arr) }
    const semver = (v: string) => v.split('.').map(Number)
    const cmp = (a: string, b: string) => { const [x, y] = [semver(a), semver(b)]; return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!) }
    for (const arr of byPlatform.values()) {
      const stale = arr.sort((a, b) => cmp(b.version, a.version)).slice(KEEP_VERSIONS)
      for (const s2 of stale) {
        const del = await fetch(`${base}/${hosting.bucket}/objects/${encodeURIComponent(s2.key)}`, { method: 'DELETE', headers: H })
        console.log(`${del.ok ? '已清理旧版' : '清理失败(不影响发布)'}: ${s2.key}`)
      }
    }
  } catch (e) {
    console.log(`旧版清理跳过(不影响发布): ${e instanceof Error ? e.message : e}`)
  }
  return true
}

const token = readToken()
let uploaded = false
if (token) {
  try { uploaded = await uploadR2(token) } catch (e) { console.error(`R2 上传失败: ${e instanceof Error ? e.message : e} — 降级为本地暂存`) }
}
if (!uploaded) {
  const out = join(ROOT, 'dist-update')
  mkdirSync(out, { recursive: true })
  copyFileSync(artifactPath, join(out, artifactName))
  writeFileSync(join(out, 'latest.json'), JSON.stringify(latest, null, 2))
  console.log(`已暂存到 ${out}/ — 把两个文件传到 ${hosting.baseUrl}/ 即完成发布`)
} else {
  console.log(`已发布 v${version} (${platformKey}) → ${hosting.baseUrl}/latest.json`)
  console.log('提醒:R2 bucket 需绑定自定义域(R2 → Settings → Custom Domains → 绑定 dl.tendhearth.com)后,更新源才对外可达。')
}


// ── 4. GitHub Release —— 面向新用户的下载单一事实源 (owner 2026-08-26) ──
// updater 产物(.app.tar.gz / setup.exe)进 R2 走自动更新;GitHub Release
// 挂「给新用户装」的安装包(mac: .dmg, win: setup.exe)+ changelog。下载页
// 通过 GitHub API 现拉最新 release,永不手改。--no-github 可跳过。
if (!process.argv.includes('--no-github')) {
  const tag = `desktop-v${version}`
  const isMac = platformKey.startsWith('darwin')
  // mac 给 dmg(新用户友好);win 的 setup.exe 既是 updater 产物也是安装包。
  const asset = isMac
    ? join(DESKTOP, 'src-tauri/target/release/bundle/dmg', `wechat-cc_${version}_aarch64.dmg`)
    : artifactPath
  const assetLabel = isMac ? `wechat-cc_${version}_aarch64.dmg` : `wechat-cc_${version}_windows-x64-setup.exe`
  if (!existsSync(asset)) {
    console.log(`GitHub: 找不到 ${asset} — 跳过(mac 需先 tauri build --bundles dmg)`)
  } else {
    const { spawnSync } = await import('node:child_process')
    const gh = (args: string[], opts: object = {}) => spawnSync('gh', args, { encoding: 'utf8', ...opts })
    // release 存在?不存在则建(草稿转正靠 --latest);存在则只补当前平台资产。
    const view = gh(['release', 'view', tag])
    if (view.status !== 0) {
      const notes = arg('--notes') ?? `wechat-cc 桌面版 ${version}`
      const created = gh(['release', 'create', tag, '--title', `wechat-cc ${version}`, '--notes', notes, '--latest'])
      console.log(created.status === 0 ? `GitHub: 建 release ${tag}` : `GitHub: 建 release 失败 — ${created.stderr?.slice(0, 160)}`)
    }
    // 幂等上传(--clobber 覆盖同名资产)
    const up = gh(['release', 'upload', tag, `${asset}#${assetLabel}`, '--clobber'])
    console.log(up.status === 0 ? `GitHub: 上传 ${assetLabel} → ${tag}` : `GitHub: 上传失败 — ${up.stderr?.slice(0, 160)}`)
  }
}

// ── 5. 三通道漂移校验 (2026-08-26 架构审查:三通道靠约定不靠校验) ──
// 发布后核对三处版本一致:R2 latest.json / GitHub latest release /
// 本次期望版本。任一不一致 → 醒目告警 + 非零退出,让 CI/人当场发现,
// 避免「自动更新已到新版但下载页还是旧版」这类静默漂移。
// --no-github 或 R2 未上传时,对应通道跳过校验(不误报)。
if (uploaded && !process.argv.includes('--no-verify')) {
  const problems: string[] = []
  try {
    const r2 = await (await fetch(`${hosting.baseUrl}/latest.json`, { cache: 'no-store' } as RequestInit)).json() as { version?: string }
    if (r2.version !== version) problems.push(`R2 latest.json=${r2.version} ≠ 期望 ${version}`)
  } catch (e) { problems.push(`R2 latest.json 读取失败: ${e instanceof Error ? e.message : e}`) }
  if (!process.argv.includes('--no-github')) {
    try {
      const rel = await (await fetch('https://api.github.com/repos/tendhearth/wechat-cc/releases/latest', { headers: { 'Accept': 'application/vnd.github+json' } })).json() as { tag_name?: string }
      const ghVer = (rel.tag_name ?? '').replace(/^desktop-v/, '')
      if (ghVer !== version) problems.push(`GitHub latest=${ghVer || '(无)'} ≠ 期望 ${version}`)
    } catch (e) { problems.push(`GitHub release 读取失败: ${e instanceof Error ? e.message : e}`) }
  }
  if (problems.length) {
    console.error('\n⚠️  通道漂移!三处版本不一致:')
    for (const p of problems) console.error(`   - ${p}`)
    console.error('   自动更新(R2)与下载页(GitHub)可能给用户不同版本。请修复后重跑。')
    process.exitCode = 1
  } else {
    console.log(`✓ 三通道版本一致(v${version}):R2 + GitHub 同步`)
  }
}
