#!/usr/bin/env bun
/**
 * device-e2e — Tendhearth iPhone 真机全自动验收(没人点屏幕)。见 apps/app/README.md「真机全自动验收」与 docs/maintainer/verify.md。
 *
 *   bun scripts/device-e2e.ts [--udid <UDID>] [--executor claude|codex|cursor] [--skip-build] [--prebuild] [--out <dir>] [--derived-data <dir>] [--only chat,push,revoke] [--build-only]
 *
 * 一条命令:构建(Release 配置 + 真机验收标记 e2eBuild,JS 打进包里、不靠 Metro;沙盒 APNs;自动签名 + ASC API key 自动登记设备 / 描述文件)→ devicectl 安装 →
 * 逐步跑 XCUITest(native/ios-e2e/DeviceE2ETests.swift,每步接管正在跑的 app),步骤之间在 daemon 那头铸码 / 查设备 / 派任务 / 撤销:
 *   0. 收起主人的配对(dev-e2e?op=stash):这台手机若已配对,测试设备不能把它顶掉(app 会去 unpair_self 旧位)
 *   a. 配对:POST /v1/phone/link(= 桌面「连接手机」)→ 自定义 scheme 链接经 devicectl --payload-url 送进 app → 确认卡核对码 = daemon 给的 → 连接 → 此刻在线
 *      同一链接再开 ⇒「已经用过或过期」,daemon 设备数不变
 *   b. 跟 CC 说一句,等新的 CC 气泡
 *   c. app 退后台 → 派一个会要权限的工作台任务(默认 claude:删探针文件走删除审批;codex 带原生提权提示;cursor ACP 的命令卡)→ 真 APNs 横幅(通知服务扩展解密后的标题 + 任务名)→ 点开 → 批准页 → 允许 → daemon 那头任务继续、探针文件被删
 *   d. 局域网 revoke_device 撤销测试设备 ⇒ app「这台手机已不再配对」
 *   e. 收尾(无论成败):归档任务、删 scratch、测试设备还在就撤、放回主人的配对(dev-e2e?op=restore)、冷启动确认主人那台重新在线
 * 报告:<out>/report.md + report.json,失败步骤带 devicectl 截图,每步的 xcresult 在 <out>/xcresult/。默认 <tmpdir>/tendhearth-device-e2e/<时间>。
 *
 * 只撤销自己配的那一台(按配对前后的设备列表差出来的 id);令牌从不进输出(复用 selftest-phone 的 redactLinkUrl 口径)。
 * 退出码:0 全过 / 1 有步骤失败 / 2 要主人在手机上动一下(报告里写了是哪一件)或 daemon 没在跑。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readApiInfo, type ApiInfo } from '../src/lib/api-info'
import { classifyLink, redactLinkUrl } from '../src/cli/selftest-phone'
import { customSchemeLink, humanBlocker, newDeviceIds, parseE2EOut, parseEnvFile, renderReport, type StepRecord } from './device-e2e-lib'

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const ROOT = resolve(import.meta.dir, '..')
const APP_DIR = join(ROOT, 'apps', 'app')
const IOS_DIR = join(APP_DIR, 'ios')
const BUNDLE_ID = 'com.tendhearth.app'
const STATE_DIR = process.env.WECHAT_CC_STATE_DIR || join(homedir(), '.claude', 'channels', 'wechat')
const EXECUTOR = opt('executor', 'claude')!
const ONLY = new Set((opt('only', 'pair,chat,push,revoke') ?? '').split(',').filter(Boolean))
const startedAt = new Date()
const OUT = resolve(opt('out') ?? join(tmpdir(), 'tendhearth-device-e2e', startedAt.toISOString().replace(/[:.]/g, '-')))
const DD = resolve(opt('derived-data') ?? join(tmpdir(), 'tendhearth-device-e2e', 'DerivedData'))
mkdirSync(join(OUT, 'xcresult'), { recursive: true })
mkdirSync(join(OUT, 'logs'), { recursive: true })

const steps: StepRecord[] = []
let blocker: string | null = null
const secrets = new Set<string>()
const scrub = (s: string) => { let o = s; for (const x of secrets) if (x) o = o.split(x).join('<redacted>'); return o.replace(/([?&#](?:t|d)=)[^&\s'"]+/g, '$1<redacted>') }
const log = (line: string) => console.error(`[device-e2e] ${scrub(line)}`)

// ── processes ───────────────────────────────────────────────────────
interface RunResult { code: number; out: string }
async function run(cmd: string[], o: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; logName?: string } = {}): Promise<RunResult> {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, stdout: 'pipe', stderr: 'pipe' })
  const timer = o.timeoutMs ? setTimeout(() => { try { p.kill() } catch { /* gone */ } }, o.timeoutMs) : null
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  if (timer) clearTimeout(timer)
  const out = `${stdout}\n${stderr}`
  if (o.logName) writeFileSync(join(OUT, 'logs', `${o.logName}.log`), scrub(`$ ${cmd.join(' ')}\n${out}`))
  return { code, out }
}

async function pickDevice(): Promise<string> {
  const want = opt('udid')
  const r = await run(['xcrun', 'devicectl', 'list', 'devices'])
  const phys = r.out.split('\n').filter(l => /\bphysical\b/.test(l) && /\bconnected\b/.test(l) && /iPhone/.test(l))
  const ids = phys.map(l => /([0-9A-F]{8}-[0-9A-F]{16})/.exec(l)?.[1]).filter((x): x is string => !!x)
  if (want) { if (!ids.includes(want)) throw new Blocker(`手机 ${want} 没连上(devicectl 看不到 connected):插好线、解锁、在手机上信任这台电脑`); return want }
  if (ids.length !== 1) throw new Blocker(ids.length === 0 ? '没有连着的 iPhone(插线、解锁、信任这台电脑)' : `连着 ${ids.length} 台 iPhone,用 --udid 指定一台`)
  return ids[0]!
}
class Blocker extends Error {}

let UDID = ''
const devicectl = (args: string[], logName?: string) => run(['xcrun', 'devicectl', ...args.flatMap(a => a === '@D' ? ['--device', UDID] : [a])], { timeoutMs: 120_000, logName })

async function launch(url?: string, logName?: string): Promise<void> {
  const r = await devicectl(['device', 'process', 'launch', '@D', '--terminate-existing', ...(url ? ['--payload-url', url] : []), BUNDLE_ID], logName)
  if (r.code !== 0) { const b = humanBlocker(r.out); if (b) throw new Blocker(b); throw new Error(`launch failed: ${scrub(r.out.slice(-400))}`) }
}

async function screenshot(name: string): Promise<string | undefined> {
  const file = join(OUT, `${name}.png`)
  const r = await devicectl(['device', 'capture', 'screenshot', '@D', '--destination', file])
  return r.code === 0 ? `${name}.png` : undefined
}

// ── build / install ─────────────────────────────────────────────────
const E2E_ENV = { TENDHEARTH_UITESTS: '1', TENDHEARTH_APNS_ENV: 'development' }
function ascEnv(): Record<string, string> {
  const f = join(homedir(), '.private_keys', 'app-store-connect.env')
  return existsSync(f) ? parseEnvFile(readFileSync(f, 'utf8')) : {}
}

async function build(): Promise<void> {
  const pbx = join(IOS_DIR, 'Tendhearth.xcodeproj', 'project.pbxproj')
  const hasTarget = existsSync(join(IOS_DIR, 'Tendhearth.xcodeproj', 'xcshareddata', 'xcschemes', 'TendhearthUITests.xcscheme'))
    && existsSync(pbx) && readFileSync(pbx, 'utf8').includes('TendhearthUITests')
  if (flag('prebuild') || !hasTarget) {
    // prebuild 会改写 package.json(scripts 换成 run:ios)—— 跑完原样放回(README:别提交这些改动)
    const pkg = readFileSync(join(APP_DIR, 'package.json'), 'utf8')
    const r = await run(['bunx', 'expo', 'prebuild', '--platform', 'ios', '--clean'], { cwd: APP_DIR, env: E2E_ENV, timeoutMs: 900_000, logName: 'prebuild' })
    writeFileSync(join(APP_DIR, 'package.json'), pkg)
    if (r.code !== 0) throw new Error('expo prebuild failed (logs/prebuild.log)')
  }
  // 改过 Swift 步骤不必重新 prebuild:每次构建前同步一遍
  const src = join(APP_DIR, 'native', 'ios-e2e')
  for (const f of readdirSync(src).filter(f => f.endsWith('.swift'))) copyFileSync(join(src, f), join(IOS_DIR, 'TendhearthUITests', f))
  const asc = ascEnv()
  const auth = asc.ASC_KEY_PATH && asc.ASC_KEY_ID && asc.ASC_ISSUER_ID
    ? ['-authenticationKeyPath', asc.ASC_KEY_PATH, '-authenticationKeyID', asc.ASC_KEY_ID, '-authenticationKeyIssuerID', asc.ASC_ISSUER_ID] : []
  const r = await run(['xcodebuild', 'build-for-testing', '-workspace', 'Tendhearth.xcworkspace', '-scheme', 'TendhearthUITests', '-configuration', 'Release',
    '-destination', `id=${UDID}`, '-derivedDataPath', DD, '-allowProvisioningUpdates', ...auth],
  // 构建时 expo-constants 会再求一次 app.config.js 写进包里:这两个变量不在,包里就没有 e2eBuild 标记 / 变成生产 APNs
  { cwd: IOS_DIR, env: E2E_ENV, timeoutMs: 1_800_000, logName: 'build' })
  if (r.code !== 0) {
    const b = humanBlocker(r.out); if (b) throw new Blocker(b)
    const err = r.out.split('\n').filter(l => /error:/.test(l)).slice(0, 3).join(' / ')
    throw new Error(`xcodebuild build-for-testing failed: ${err || 'see logs/build.log'}`)
  }
  const app = join(productsDir(), 'Release-iphoneos', 'Tendhearth.app')
  if (!existsSync(join(app, 'main.jsbundle'))) throw new Error('Tendhearth.app has no embedded main.jsbundle — rerun with --prebuild')
  const cfg = readFileSync(join(app, 'EXConstants.bundle', 'app.config'), 'utf8')
  if (!cfg.includes('"e2eBuild":true') || !cfg.includes('"apnsEnv":"development"')) throw new Error('built app is missing extra.e2eBuild / sandbox apnsEnv (EXConstants.bundle/app.config)')
}

function productsDir(): string { return join(DD, 'Build', 'Products') }

/** build-for-testing 产出的 .xctestrun。UI 测试必须带 UITargetAppPath(删掉 xcodebuild 直接拒跑);被测 app 没变就不会重装,正在跑的 app 不受影响。 */
function xctestrun(): string {
  const f = readdirSync(productsDir()).find(n => n.endsWith('.xctestrun'))
  if (!f) throw new Error('no .xctestrun under DerivedData (build first)')
  return join(productsDir(), f)
}

async function install(): Promise<void> {
  const app = join(productsDir(), 'Release-iphoneos', 'Tendhearth.app')
  const r = await devicectl(['device', 'install', 'app', '@D', app], 'install')
  if (r.code !== 0) { const b = humanBlocker(r.out); if (b) throw new Blocker(b); throw new Error(`install failed: ${r.out.slice(-400)}`) }
}

// ── UI steps ────────────────────────────────────────────────────────
let XCTESTRUN = ''
async function ui(test: string, env: Record<string, string> = {}, timeoutMs = 400_000): Promise<{ ok: boolean; outs: Record<string, string>; detail: string }> {
  const bundle = join(OUT, 'xcresult', `${test}-${Date.now()}.xcresult`)
  const r = await run(['xcodebuild', 'test-without-building', '-xctestrun', XCTESTRUN, '-destination', `id=${UDID}`,
    `-only-testing:TendhearthUITests/DeviceE2ETests/${test}`, '-resultBundlePath', bundle],
  { env: Object.fromEntries(Object.entries(env).map(([k, v]) => [`TEST_RUNNER_${k}`, v])), timeoutMs, logName: `ui-${test}-${Date.now()}` })
  const outs = parseE2EOut(r.out)
  const ok = r.code === 0 && /\*\* TEST EXECUTE SUCCEEDED \*\*|Test Suite .* passed/.test(r.out)
  if (!ok) { const b = humanBlocker(r.out); if (b) blocker = blocker ?? b }
  const fails = r.out.split('\n').filter(l => /error: -\[|XCTAssert|failed \(|timeout after/.test(l)).slice(0, 3).map(l => l.trim()).join(' / ')
  return { ok, outs, detail: ok ? '' : scrub(fails || r.out.slice(-300)) }
}

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const t0 = Date.now()
  log(`▶ ${name}`)
  try {
    const detail = await fn()
    steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ? scrub(detail) : undefined })
    log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${detail ? ` — ${scrub(detail)}` : ''}`)
    return true
  } catch (e) {
    if (e instanceof Blocker) blocker = blocker ?? e.message
    const msg = scrub(e instanceof Error ? e.message : String(e))
    const shot = UDID ? await screenshot(`fail-${name}`) : undefined
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: msg, screenshot: shot })
    log(`✗ ${name} — ${msg}`)
    return false
  }
}

async function uiStep(test: string, env: Record<string, string> = {}, timeoutMs?: number): Promise<Record<string, string>> {
  const r = await ui(test, env, timeoutMs)
  if (!r.ok) throw new Error(`${test}: ${r.detail}${Object.keys(r.outs).length ? ` | ${JSON.stringify(r.outs)}` : ''}`)
  return r.outs
}

// ── daemon ──────────────────────────────────────────────────────────
let API: ApiInfo
async function call(method: string, path: string, body?: unknown, base?: string, bearer?: string | null): Promise<{ ok: boolean; status: number; json: any }> {
  try {
    const res = await fetch(`${base ?? API.baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer ?? API.operatorToken}` }), 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json: any = null
    try { json = await res.json() } catch { /* empty */ }
    return { ok: res.ok, status: res.status, json }
  } catch (e) { return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : String(e) } } }
}
type DeviceRow = { id: string; created_at?: string; last_seen_at?: string; label?: string }
async function devices(): Promise<DeviceRow[]> {
  const r = await call('GET', '/v1/phone/devices')
  if (!r.ok || !Array.isArray(r.json?.devices)) throw new Error(`GET /v1/phone/devices: http_${r.status} ${r.json?.error ?? ''}`)
  return r.json.devices
}
/** 桌面「连接手机」同一条路:铸一枚一次性链接令牌(admin 档,10 分钟)。 */
async function mintLink(): Promise<{ url: string; checkCode: string; host: string; lanBase: string; linkToken: string }> {
  const r = await call('POST', '/v1/phone/link', { enable_remote: false })
  if (!r.ok || r.json?.ok !== true || typeof r.json?.url !== 'string') throw new Error(`POST /v1/phone/link: ${r.json?.state ?? r.json?.error ?? `http_${r.status}`}`)
  const url = r.json.url as string
  const cls = classifyLink(url)
  if (cls.kind !== 'remote') throw new Error(`link is not a relay link: ${redactLinkUrl(url)}`)
  secrets.add(cls.link.linkToken)
  return { url, checkCode: String(r.json.check_code), host: cls.link.host, lanBase: cls.link.lanBase, linkToken: cls.link.linkToken }
}
/** 局域网撤销一台设备(设置页 /set「忘掉」同一个 op;revoke_device 只许走局域网)。 */
async function revoke(id: string): Promise<void> {
  const link = await mintLink()
  const r = await call('POST', `/set/api/apply?t=${encodeURIComponent(link.linkToken)}`, { op: 'revoke_device', id }, link.lanBase, null)
  if (r.json?.ok !== true) throw new Error(`revoke_device ${id}: ${r.json?.error ?? `http_${r.status}`}`)
}
function pushRegistered(): string[] {
  // 只读键名(设备 id),不读 / 不打印 APNs token
  try { return Object.keys(JSON.parse(readFileSync(join(STATE_DIR, 'phone-push.json'), 'utf8'))) } catch { return [] }
}
async function waitFor<T>(ms: number, f: () => Promise<T | null | undefined> | T | null | undefined, every = 1000): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) return null
    await Bun.sleep(every)
  }
}

// ── main ────────────────────────────────────────────────────────────
const nonce = Math.random().toString(36).slice(2, 8)
let testDeviceId: string | undefined
let ownerStash: string | undefined
/** 收起那一步一旦发出去,收尾就一定去放回(放回在没收着东西时什么都不做)—— 哪怕收的结果没读出来。 */
let stashAttempted = false
let restored = false
let taskId: string | undefined
let scratch: string | undefined

async function main(): Promise<number> {
  const api = readApiInfo(STATE_DIR)
  if (!api) { blocker = `daemon 没在跑(${STATE_DIR}/internal-api-info.json 读不到)`; return 2 }
  API = api
  secrets.add(api.token); secrets.add(api.operatorToken)

  const pre = await step('preflight', async () => {
    UDID = await pickDevice()
    const lock = await devicectl(['device', 'info', 'lockState', '@D'])
    if (/passcodeRequired:\s*true/.test(lock.out)) throw new Blocker('手机锁着:解锁并保持亮屏(自动锁定设成「永不」,跑完改回)')
    const h = await call('GET', '/v1/health', undefined, undefined, api.token)
    if (!h.ok) throw new Error(`daemon health: http_${h.status}`)
    const hz = await call('GET', '/healthz', undefined, 'https://relay-staging.tendhearth.com', null)
    return `device ${UDID}; daemon head ${h.json?.version?.head ?? '?'}; relay apns=${hz.json?.apns}`
  })
  if (!pre) return finish()

  if (!flag('skip-build')) { if (!(await step('build', async () => { await build(); return `DerivedData ${DD}` }))) return finish() }
  if (!(await step('install', async () => { await install(); XCTESTRUN = xctestrun() }))) return finish()
  if (flag('build-only')) return finish()

  // 0. 收起主人的配对(这一步失败就不往下走:否则测试设备会顶掉主人的配对)
  const stashed = await step('stash_owner_pairing', async () => {
    stashAttempted = true
    await launch('tendhearth://dev-e2e?op=stash', 'launch-stash')
    const o = await uiStep('testDevE2EResult')
    ownerStash = o.dev_e2e
    if (!ownerStash || !/^stash-(stashed|already_stashed|nothing)$/.test(ownerStash)) throw new Error(`dev-e2e said ${ownerStash}`)
    return ownerStash === 'stash-already_stashed' ? 'a stash from an earlier interrupted run is kept (that one is the owner\'s)' : ownerStash
  })
  if (!stashed) { await cleanup(); return finish() }

  try {
    let link: Awaited<ReturnType<typeof mintLink>> | undefined
    const before = await devices()
    const paired = await step('a_pair', async () => {
      link = await mintLink()
      const custom = customSchemeLink(link.url)
      if (!custom) throw new Error('could not build the custom-scheme link')
      await launch(custom, 'launch-pair')
      const o = await uiStep('testPairConfirmAndConnect', { E2E_CHECK_CODE: link.checkCode, E2E_RELAY_HOST: link.host })
      const added = await waitFor(15_000, async () => { const n = newDeviceIds(before, await devices()); return n.length ? n : null })
      if (!added || added.length !== 1) throw new Error(`expected exactly one new device on the daemon, got ${JSON.stringify(added)}`)
      testDeviceId = added[0]
      return `card ${o.check_code_label} (daemon ${link.checkCode}), host ${link.host}; ${o.status_label}; new device ${testDeviceId}`
    })
    if (paired && link) {
      await step('a_pair_reuse_rejected', async () => {
        const n0 = (await devices()).length
        await launch(customSchemeLink(link!.url)!, 'launch-reuse')
        const o = await uiStep('testPairReuseRejected')
        const n1 = (await devices()).length
        if (n1 !== n0) throw new Error(`device count changed ${n0} → ${n1}`)
        return o.reuse_error
      })
      await step('a_push_registered', async () => {
        const ok = await waitFor(30_000, () => pushRegistered().includes(testDeviceId!) || null)
        if (!ok) throw new Error('the test device never registered for push (phone-push.json) — notification permission denied?')
        return 'test device registered its APNs token with the daemon'
      })
    }

    if (paired && ONLY.has('chat')) {
      await step('b_chat', async () => {
        const text = `device-e2e ${nonce}: reply with one short sentence`
        const o = await uiStep('testChat', { E2E_CHAT_TEXT: text }, 400_000)
        return `CC: ${o.reply_label ?? '?'}`
      })
    }

    if (paired && ONLY.has('push')) {
      await step('c_push_approve', async () => {
        scratch = join(tmpdir(), 'wechat-cc-selftest', `device-${Date.now()}`)
        mkdirSync(scratch, { recursive: true })
        writeFileSync(join(scratch, 'README.md'), 'Tendhearth device e2e scratch project\n')
        writeFileSync(join(scratch, 'cc-selftest-permission-probe.txt'), 'Disposable permission probe created by device-e2e.\n')
        await run(['git', 'init', '-q'], { cwd: scratch }); await run(['git', 'add', '-A'], { cwd: scratch })
        await run(['git', '-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', 'commit', '-qm', 'init'], { cwd: scratch })
        await uiStep('testBackground')
        const title = `device-e2e ${nonce}`
        // 点横幅那一步先起(xcodebuild 起 runner 要十几秒),再派任务;它自己等横幅,等不到就去通知中心找
        const tap = ui('testTapPushAndApprove', { E2E_TASK_TITLE: title }, 400_000)
        await Bun.sleep(15_000)
        const c = await call('POST', '/v1/workbench/create', {
          path: scratch, providerId: EXECUTOR, title,
          text: '在项目根目录运行 shell 命令 `rm -- cc-selftest-permission-probe.txt`，只删除这个一次性文件(这是手机真机验收的权限往返)。然后回复一句「已删除」并结束。不要做别的。'
            + (EXECUTOR === 'codex' ? '\n上述删除命令必须通过 exec_command 的 sandbox_permissions="require_escalated" 发起一次原生审批(说明仅删除验收文件),不要先在沙箱内执行。' : ''),
        })
        taskId = c.json?.task?.id
        if (!taskId) throw new Error(`workbench/create: ${c.json?.error ?? `http_${c.status}`}`)
        let taskError: string | undefined
        const sawPerm = await waitFor(150_000, async () => {
          const d = await call('GET', `/v1/workbench/task?id=${taskId}&since=0&wait_ms=5000`)
          if (d.json?.task?.status === 'failed') { taskError = String(d.json.task.error ?? 'failed'); return true }
          return (d.json?.permissions?.length ?? 0) > 0 || null
        }, 500)
        // 执行者自己挂了(额度用完等):别让点横幅那一步空等满 150 秒才说
        if (taskError) { await tap; throw new Error(`the ${EXECUTOR} task failed before asking for a permission: ${taskError} — try --executor codex|claude|cursor`) }
        const t = await tap
        if (!t.ok) throw new Error(`${sawPerm ? 'permission card was pending on the daemon' : 'no permission card on the daemon within 150s'}; UI: ${t.detail} | ${JSON.stringify(t.outs)}`)
        // daemon 那头:权限放行后任务往下走、探针被删
        const done = await waitFor(120_000, async () => {
          const d = await call('GET', `/v1/workbench/task?id=${taskId}&since=0&wait_ms=5000`)
          const st = d.json?.task
          const left = d.json?.permissions?.length ?? 0
          return left === 0 && !existsSync(join(scratch!, 'cc-selftest-permission-probe.txt')) && (st?.phase === 'replied' || st?.status === 'completed') ? st : null
        }, 1000)
        if (!done) throw new Error('after approving on the phone, the daemon task did not finish / the probe file is still there')
        return `banner(${t.outs.banner_source}): ${t.outs.banner_label}; approval ${t.outs.approval_title ?? ''}; task ${done.status}/${done.phase}, probe removed`
      })
    }

    if (paired && ONLY.has('revoke')) {
      await step('d_revoke', async () => {
        await revoke(testDeviceId!)
        const gone = !(await devices()).some(d => d.id === testDeviceId)
        if (!gone) throw new Error('device still listed after revoke_device')
        const id = testDeviceId
        testDeviceId = undefined
        const o = await uiStep('testRevokedNotice')
        return `revoked ${id}; app: ${o.revoked_label}`
      })
    }
  } finally {
    await cleanup()
  }
  return finish()
}

async function cleanup(): Promise<void> {
  await step('e_cleanup', async () => {
    const notes: string[] = []
    if (taskId) {
      const d = await call('GET', `/v1/workbench/task?id=${taskId}&since=0&wait_ms=0`)
      const st = d.json?.task?.status
      if (st && !['completed', 'failed', 'cancelled', 'interrupted'].includes(st)) {
        await call('POST', '/v1/workbench/cancel', { id: taskId })
        await waitFor(20_000, async () => { const x = await call('GET', `/v1/workbench/task?id=${taskId}&since=0&wait_ms=2000`); return ['completed', 'failed', 'cancelled', 'interrupted'].includes(x.json?.task?.status) || null })
      }
      const a = await call('POST', '/v1/workbench/archive', { id: taskId, archived: true })
      notes.push(a.ok ? `archived ${taskId}` : `archive ${taskId} failed: ${a.json?.error ?? a.status}`)
      if (!a.ok) throw new Error(notes.join('; '))
    }
    if (scratch) { rmSync(scratch, { recursive: true, force: true }); notes.push('scratch removed') }
    if (testDeviceId) { await revoke(testDeviceId); notes.push(`revoked leftover test device ${testDeviceId}`); testDeviceId = undefined }
    if (stashAttempted) {
      const t0 = new Date()
      await launch('tendhearth://dev-e2e?op=restore', 'launch-restore')
      const o = await uiStep('testDevE2EResult')
      notes.push(`restore: ${o.dev_e2e}`)
      if (!/^restore-(restored|nothing)$/.test(o.dev_e2e ?? '')) throw new Error(notes.join('; '))
      restored = true
      await launch(undefined, 'launch-owner')
      if (o.dev_e2e === 'restore-restored') {
        // 「在线」= 这次启动用放回的令牌同步成功过(presence 的 verified 判定);last_seen_at 有写盘节流,只作参考
        const o2 = await uiStep('testOwnerOnline')
        const seen = (await devices()).find(d => d.last_seen_at && new Date(d.last_seen_at) >= t0)
        notes.push(`owner pairing back: ${o2.status_label ?? 'online'}${seen ? ` (device ${seen.id} last_seen fresh)` : ''}`)
      } else {
        notes.push('phone was not paired before the run; left unpaired')
      }
    }
    return notes.join('; ')
  })
}

function finish(): number {
  if (stashAttempted && !restored && !steps.some(s => s.name === 'owner_pairing_left_stashed')) {
    steps.push({ name: 'owner_pairing_left_stashed', ok: false, ms: 0,
      detail: `主人的配对可能还收在 app 的收纳格里。放回:xcrun devicectl device process launch --device ${UDID} --terminate-existing --payload-url 'tendhearth://dev-e2e?op=restore' ${BUNDLE_ID}(或重跑本脚本:收起那一步见到已收着的一份不会覆盖它)` })
  }
  const ok = !blocker && steps.length > 0 && steps.every(s => s.ok)
  const report = { ok, startedAt: startedAt.toISOString(), udid: UDID, steps, blocker, outDir: OUT }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'report.md'), renderReport(report))
  console.log(renderReport(report))
  return blocker ? 2 : ok ? 0 : 1
}

if (import.meta.main) process.exit(await main())
