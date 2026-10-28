/**
 * 真实形状沙盒(real-shaped sandbox):起**完整的** daemon(bootDaemon,经 harness 的 startTestDaemon),配置的形状照主人
 * 那台真机 —— 主人设好了、主动关心开着、知识库开着、记忆文件 + facts.db 在、社交 / 配对 / A2A / 乙 / 手机中继 / 网络守护 /
 * 语音 / 信 / 工作室都开着 —— 替身**只在系统边界**:微信 ilink(fake-ilink-server)、模型 SDK(fake-sdk)、外网 / 中继 /
 * 嵌入子进程(fake-boundaries + 下面写进 stateDir 的假嵌入脚本)。daemon 内部的模块一个都不 mock。
 *
 * 为什么要有它:2026-10-26 #729 在 boot-api 的 `if (boot.knowledge)` 里加了 `ctx.late('wired')`,没写进 `lazy`。单测、CI
 * 全绿 —— 没有一条测试带着知识库开机;真机开机三连败、自动回滚(#733 修)。可选子系统只在「开着」时走的那几行,
 * 只有照真机的样子开机才走得到。新加的可选子系统 / 配置开关,在这里也开上(README 有一张「开了什么、为什么没开」的表)。
 *
 * 用法:
 *   const d = await startRealShapedDaemon({ claudeScript })
 *   try { … d.health() / d.moduleProblems() / d.sendText(d.owner, '…') … } finally { await d.stop() }
 *   重启:`await d.stop({ keepState: true })`,再 `startRealShapedDaemon({ stateDir: d.stateDir, … })`(不重新播种)。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqlite } from '../../lib/runtime/sqlite'
import { removeTempDir } from '../../lib/test-temp'
import { readJsonFile } from '../../lib/read-json-file'
import { writeJsonAtomic } from '../../lib/json-file'
import { openKnowledge } from '../../adapters/knowledge/store'
import { migrations as factsMigrations } from '../../adapters/knowledge/migrations/facts'
import { startTestDaemon, type DaemonHandle, type TestDaemonOpts } from './harness'
import { fenceNetwork, freePort, startFakeInternet, startFakeMailboxRelay, startFakePhoneRelay, type FakeInternet, type FakeMailboxRelay, type FakePhoneRelay, type NetworkFence } from './fake-boundaries'

const HERE = dirname(fileURLToPath(import.meta.url))
const MEMORY_FIXTURES = join(HERE, '..', '..', 'test-support', 'fixtures', 'memory')

/** 主人 / 访客的对话 id —— 跟记忆金样(src/features/memory/memory-golden.test.ts)用同一对,夹具文件原样拷进来。 */
export const SANDBOX_OWNER = 'o9fixture-owner@im.wechat'
export const SANDBOX_GUEST = 'o9fixture-guest@im.wechat'

export interface RealShapedOpts extends Pick<TestDaemonOpts, 'claudeScript' | 'codexScript' | 'cursorScript' | 'moderatorScript' | 'recordClaudeSpawnOptions' | 'recordCodexSpawnOptions' | 'modes' | 'seedFiles'> {
  /** 复用上一次的 stateDir(重启场景):不再播种记忆 / 知识库 / 对话,只把指向替身的 URL 换成这次的端口。 */
  stateDir?: string
  /** 盖在 agent-config.json 上的几项(这次开机的「机器上变了什么」,比如 a2a 端口被别的程序占了)。 */
  agentConfigPatch?: Record<string, unknown>
}

export interface HealthBody {
  ok: boolean
  subsystems: Array<{ name: string; state: string; error?: string }>
  guard: { enabled: boolean; safe: boolean; source: string; detail: string }
  [k: string]: unknown
}

export interface RealShapedDaemon extends Omit<DaemonHandle, 'stop'> {
  owner: string
  guest: string
  internet: FakeInternet
  mailbox: FakeMailboxRelay
  phoneRelay: FakePhoneRelay
  fence: NetworkFence
  /** 这次开机以来 daemon 打出来的日志行(`[TAG] …`,捕获自 stderr —— channel.log 在同一个测试文件里会冻在第一个 daemon 的目录上)。 */
  log(): string[]
  /** GET /v1/health(文件令牌)。 */
  health(): Promise<HealthBody>
  /** 开机 / 运行中坏了的模块:health 里 degraded 的 + 日志里 `[MODULES] … failed|degraded` 的。空 = 全好。 */
  moduleProblems(): Promise<string[]>
  /** 对主库(wechat-cc.db)跑一条只读查询。 */
  query<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[]
  /** keepState:留着 stateDir 给下一次开机(重启场景);替身照样关掉。 */
  stop(opts?: { keepState?: boolean }): Promise<void>
}

/** 假嵌入子进程:和 embed_subprocess.py 同一个协议(stdin 一行 `{"texts":[…]}` → stdout 一行 `{"vectors":[…]}`),不下模型、不出网。 */
const FAKE_EMBED_PY = `import sys, json, hashlib
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        texts = json.loads(line).get("texts", [])
        vecs = []
        for t in texts:
            h = hashlib.sha256(t.encode("utf-8")).digest()
            vecs.append([((h[i % 32] / 255.0) - 0.5) for i in range(512)])
        print(json.dumps({"vectors": vecs}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
`

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, value)
}

/** 知识库:三个库 + 旧的 knowledge/facts.db(开机导入把它搬进主库)。照 memory-golden.test.ts 的 seedKnowledge。 */
function seedKnowledge(root: string): void {
  openKnowledge(root).close()
  const fixture = readJsonFile<{ facts: Array<Record<string, unknown>>; contacts: Array<Record<string, unknown>> }>(join(MEMORY_FIXTURES, 'facts.json'))
  const facts = openSqlite(join(root, 'facts.db'))
  factsMigrations[0]!(facts)
  for (const f of fixture.facts) {
    facts.query(`INSERT INTO facts(id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys,
      status, created_at, updated_at, valid_from, invalidated_at, superseded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.id as number, f.contact as string, f.kind as string, f.predicate as string, f.value as string, (f.related_contact ?? null) as string | null,
      (f.time_ref ?? null) as string | null, f.confidence as string, JSON.stringify(f.source_msg_keys ?? []), f.status as string,
      f.created_at as number, f.updated_at as number, (f.valid_from ?? null) as number | null, (f.invalidated_at ?? null) as number | null,
      (f.superseded_by ?? null) as number | null,
    )
  }
  facts.close()
  const graph = openSqlite(join(root, 'graph.db'))
  for (const c of fixture.contacts) {
    graph.query(`INSERT INTO contacts(username, display, is_group, closeness, last_ts, total, s_volume, s_intimacy, s_recency) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      c.username as string, c.display as string, c.is_group as number, c.closeness as number, c.last_ts as number, c.total as number,
      c.s_volume as number, c.s_intimacy as number, c.s_recency as number,
    )
  }
  graph.close()
}

/** 只在第一次开机前:记忆文件、知识库、主人 / 访客的对话路由。 */
function seedMachine(stateDir: string): void {
  cpSync(join(MEMORY_FIXTURES, 'chats', 'owner'), join(stateDir, 'memory', SANDBOX_OWNER), { recursive: true })
  cpSync(join(MEMORY_FIXTURES, 'chats', 'guest'), join(stateDir, 'memory', SANDBOX_GUEST), { recursive: true })
  seedKnowledge(join(stateDir, 'knowledge'))
  // 主人跟 CC 说过话:有 context_token,开机的通知(重启 / 降级汇总)发得出去
  writeJson(join(stateDir, 'context_tokens.json'), { [SANDBOX_OWNER]: `ctx-${SANDBOX_OWNER}`, [SANDBOX_GUEST]: `ctx-${SANDBOX_GUEST}` })
  writeFileSync(join(stateDir, 'fake-embed.py'), FAKE_EMBED_PY)
}

/** 每次开机前:配置文件。指向替身的 URL / 端口每次重写(替身每次是新端口),其余照真机。 */
function writeConfig(stateDir: string, fakes: { internet: FakeInternet; mailbox: FakeMailboxRelay; phoneRelay: FakePhoneRelay }, patch: Record<string, unknown> = {}): void {
  writeJson(join(stateDir, 'agent-config.json'), {
    provider: 'claude',
    dangerouslySkipPermissions: false,
    autoStart: true,
    closeStopsDaemon: false,
    bot_name: 'CC',
    // 知识库(#729 那一类问题就藏在这里):嵌入走 python 子进程那条路,脚本是假的
    knowledge_enabled: true,
    knowledge_embed_script: join(stateDir, 'fake-embed.py'),
    knowledge_owner: SANDBOX_OWNER,
    // CC 之间的往来:A2A 服务、笔友信箱、配对、社交、乙 hub
    a2a_listen: { host: '127.0.0.1', port: freePort() },
    mailbox_relays: [fakes.mailbox.url],
    social_enabled: true,
    social_disclosure_policy: '只说主人愿意公开的:兴趣、近况的大概;不说住址、家人、工作单位。',
    yi_hub_listen: { host: '127.0.0.1', port: freePort() },
    // 出门也能用(手机中继 v2)
    remote_tunnel: true,
    relay_v2_url: fakes.phoneRelay.url,
    ...patch,
  })
  writeJson(join(stateDir, 'companion', 'config.json'), {
    enabled: true,
    timezone: 'Asia/Shanghai',
    default_chat_id: SANDBOX_OWNER,
    snooze_until: null,
    last_introspect_at: null,
    memory_nightly_enabled: true,
    memory_nightly_at: '04:00',
    letters_enabled: true,
    atelier_mode: 'private',
  })
  // 网络守护开着,信号走探测(沙盒里没有 bx);探测和出口 IP 打到本机替身
  writeJson(join(stateDir, 'guard.json'), {
    enabled: true,
    signal_source: 'probe',
    probe_url: `${fakes.internet.baseUrl}/generate_204`,
    ipify_url: `${fakes.internet.baseUrl}/ip`,
    protect: [], trust: [], protect_custom_gateways: false, max_suspend_minutes: 30,
  })
  writeJson(join(stateDir, 'voice-config.json'), { provider: 'http_tts', base_url: `${fakes.internet.baseUrl}/tts`, model: 'sandbox-tts', saved_at: '2026-10-27T00:00:00.000Z' })
}

const LOG_PREFIX = 'wechat channel: '

export async function startRealShapedDaemon(opts: RealShapedOpts = {}): Promise<RealShapedDaemon> {
  const fresh = !opts.stateDir
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'wechat-cc-sandbox-'))
  const internet = startFakeInternet(), mailbox = startFakeMailboxRelay(), phoneRelay = startFakePhoneRelay()
  if (fresh) seedMachine(stateDir)
  writeConfig(stateDir, { internet, mailbox, phoneRelay }, opts.agentConfigPatch)

  // 日志:从 stderr 抓(log.ts 每行都写 stderr)。SANDBOX_LOG=1 时照样打出来。
  const lines: string[] = []
  const origWrite = process.stderr.write.bind(process.stderr)
  const echo = process.env.SANDBOX_LOG === '1'
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (s.startsWith(LOG_PREFIX)) {
      for (const l of s.slice(LOG_PREFIX.length).split('\n')) if (l.trim()) lines.push(l)
      if (!echo) { const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined; cb?.(); return true }
    }
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write

  // 真机由 launchd 拉起(service install 写进 WECHAT_CC_SUPERVISED=1)⇒ 空闲自动重启那个模块是开着的。
  // 它要重启时走 process.exit —— 在测试进程里那就是把 vitest 杀了,所以这里接住、记一行、不退。
  const origSupervised = process.env.WECHAT_CC_SUPERVISED
  process.env.WECHAT_CC_SUPERVISED = '1'
  const origExit = process.exit
  process.exit = ((code?: number) => { lines.push(`[SANDBOX] process.exit(${code ?? ''}) intercepted`); return undefined as never }) as typeof process.exit

  const fence = fenceNetwork()
  const restoreProcess = () => {
    fence.restore()
    process.exit = origExit
    if (origSupervised === undefined) delete process.env.WECHAT_CC_SUPERVISED
    else process.env.WECHAT_CC_SUPERVISED = origSupervised
    process.stderr.write = origWrite as typeof process.stderr.write
  }
  const stopFakes = () => { internet.stop(); mailbox.stop(); phoneRelay.stop() }

  let daemon: DaemonHandle
  try {
    daemon = await startTestDaemon({
      ...opts,
      stateDirOverride: stateDir,
      dangerously: false,
      // 主人是唯一的 admin;访客在白名单里(请求-批准那条路走过了)
      access: { allowFrom: [SANDBOX_OWNER, SANDBOX_GUEST], admins: [SANDBOX_OWNER] },
      knownUsers: { [SANDBOX_OWNER]: '主人', [SANDBOX_GUEST]: '小林' },
      // 扫码绑定的那个微信就是主人
      botUserId: SANDBOX_OWNER,
      claudeScript: opts.claudeScript ?? { async onDispatch() { return { toolCalls: [], finalText: '好的。' } } },
    })
  } catch (err) {
    restoreProcess(); stopFakes()
    if (fresh) removeTempDir(stateDir)
    const tail = lines.filter(l => /\[(MODULES|DAEMON|SUBSYS)\]/.test(l)).slice(-15).join('\n')
    throw new Error(`real-shaped daemon failed to boot: ${err instanceof Error ? err.message : String(err)}\n--- log tail ---\n${tail}`)
  }

  const info = () => readJsonFile<{ baseUrl: string; tokenFilePath: string }>(join(stateDir, 'internal-api-info.json'))
  const health = async (): Promise<HealthBody> => {
    const i = info()
    const r = await fetch(`${i.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${readFileSync(i.tokenFilePath, 'utf8').trim()}` } })
    if (r.status !== 200) throw new Error(`/v1/health → ${r.status}`)
    return await r.json() as HealthBody
  }

  return {
    ...daemon,
    owner: SANDBOX_OWNER,
    guest: SANDBOX_GUEST,
    internet, mailbox, phoneRelay, fence,
    log: () => lines,
    health,
    async moduleProblems() {
      const h = await health()
      return [
        ...h.subsystems.filter(s => s.state === 'degraded').map(s => `${s.name}: degraded (${s.error ?? '?'})`),
        ...lines.filter(l => /\[MODULES\] .*(failed|degraded)/.test(l)),
      ]
    },
    query<T>(sql: string, ...params: Array<string | number | null>): T[] {
      const db = openSqlite(join(stateDir, 'wechat-cc.db'), { readonly: true })
      try { return db.query(sql).all(...params) as T[] } finally { db.close() }
    },
    async stop(o = {}) {
      try { await daemon.stop() } finally {
        restoreProcess(); stopFakes()
        if (!o.keepState && existsSync(stateDir)) removeTempDir(stateDir)
      }
    },
  }
}
