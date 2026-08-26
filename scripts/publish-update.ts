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

// ── 1. collect this platform's artifacts ────────────────────────────────
const platformKey = process.platform === 'darwin'
  ? `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  : process.platform === 'win32' ? 'windows-x86_64' : `linux-${process.arch}`

let artifactPath: string
let sigPath: string
if (process.platform === 'darwin') {
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
const artifactName = `wechat-cc_${version}_${platformKey}${process.platform === 'darwin' ? '.app.tar.gz' : '-setup.exe'}`
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
function readToken(): string | null {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN.trim()
  const f = join(homedir(), 'Desktop', 'cloudflare_key.txt')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
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
  await put(artifactName, new Uint8Array(readFileSync(artifactPath)), 'application/octet-stream')
  await put('latest.json', JSON.stringify(latest, null, 2), 'application/json')

  // 旧版清理 — 每平台只留最近 KEEP_VERSIONS 版,免费额度(10GB)永远够用。
  try {
    const KEEP_VERSIONS = 3
    const list = await fetch(`${base}/${hosting.bucket}/objects?per_page=1000`, { headers: H })
    const listBody = await list.json() as { success: boolean; result?: Array<{ key: string }> }
    const keys = (listBody.result ?? []).map(o => o.key)
    // key 形如 wechat-cc_<semver>_<platform>(.app.tar.gz|-setup.exe)
    const parsed = keys
      .map(k => { const m = k.match(/^wechat-cc_(\d+\.\d+\.\d+)_(.+?)(\.app\.tar\.gz|-setup\.exe)$/); return m ? { key: k, version: m[1]!, platform: m[2]! } : null })
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
