// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { loadAgentConfig } from '../../lib/agent-config'
import { compiledRepoRoot, isCompiledBundle } from '../../lib/runtime-info'
import { parseTimeoutMsFlag, parseBudgetUsdFlag } from '../flags'
// 源码模式下的仓库根:原来这段代码住在根 cli.ts 里,用 import.meta.url 就是仓库根;搬家后统一从 repo-root 取。
import { SOURCE_REPO_ROOT } from '../repo-root'
// ── self deploy — atomic sidecar swap + launchd restart + health gate ──
//
// spec: docs/superpowers/specs/2026-09-18-self-maintenance-design.md §3.
// macOS/launchd only (Windows/Linux self deploy is explicitly out of scope —
// exit 2). repoRoot in source mode is this file's own directory (cli.ts
// lives at the repo root); compiled bundles have no repo checkout nearby,
// so --binary is required there.

const selfDeployCmd = defineCommand({
  meta: { name: 'deploy', description: '原子换 sidecar 进 .app、重启 daemon(launchd)、健康门,失败自动回滚(仅 macOS)' },
  args: {
    binary: { type: 'string', description: '新 sidecar 二进制路径(源码模式缺省按 repoRoot + 架构推导;打包模式下必填)' },
    app: { type: 'string', description: '.app 包路径,覆盖从 LaunchAgent plist 推导的部署目标' },
    'no-rollback': { type: 'boolean', description: '健康门失败时不自动回滚（默认会回滚）' },
    'allow-missing-plugins': { type: 'boolean', description: '插件门红了也放行(记日志);给本来就没有插件的机器,不必永久 plugin disable' },
    'no-sign': { type: 'boolean', description: '不用本机钥匙串里的 Developer ID 重签 sidecar 与 .app(缺省:有证书就签)' },
    'allow-unsigned': { type: 'boolean', description: '.app 是 Developer ID 封的、这次却不签,也照样换(缺省拒绝:ad-hoc sidecar 会让 daemon 卡在 TCC 框)' },
    'health-timeout-ms': { type: 'string', description: '健康门超时,毫秒(缺省 60000)' },
    json: { type: 'boolean', description: 'JSON 输出（SelfDeployResult）' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    if (process.platform !== 'darwin') {
      const message = 'self deploy only supports macOS (launchd) — see spec §3'
      if (json) console.log(JSON.stringify({ ok: false, exitCode: 2, error: 'self_deploy_unsupported_platform', message }, null, 2))
      else console.error(message)
      process.exit(2)
      return
    }

    const { planSelfDeploy, executeSelfDeploy, defaultSelfDeployDeps, resolveSigningInputs, pluginSourceCandidates } = await import('../self-deploy.ts')
    const { homedir } = await import('node:os')
    const { existsSync, readFileSync } = await import('node:fs')

    const compiled = isCompiledBundle()
    if (compiled && !args.binary) {
      const message = 'compiled bundle: --binary is required (no repo checkout nearby to derive the sidecar path from)'
      if (json) console.log(JSON.stringify({ ok: false, exitCode: 1, error: 'binary_required', message }, null, 2))
      else console.error(message)
      process.exit(1)
      return
    }

    const repoRoot = compiledRepoRoot() ?? SOURCE_REPO_ROOT
    const homeDir = homedir()
    const plistPath = join(homeDir, 'Library', 'LaunchAgents', 'com.wechat-cc.daemon.plist')
    const plistXml = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : null
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501
    const healthTimeout = parseTimeoutMsFlag(args['health-timeout-ms'])
    if (!healthTimeout.ok) {
      const message = `--health-timeout-ms ${healthTimeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, exitCode: 1, error: 'invalid_health_timeout_ms', message }, null, 2))
      else console.error(`self deploy: ${message}`)
      process.exit(1)
      return
    }

    // 签名:本机钥匙串里有 Developer ID 就用它重签(见 self-deploy.ts 文件头);
    // `--no-sign` 关掉。citty/mri 对 `--no-sign` 的处理与 `--no-rollback` 同一套
    // (boolean 取反落到 `sign:false`),两种拼法都认。
    const deps = defaultSelfDeployDeps()
    const noSign = (args as Record<string, unknown>)['no-sign'] === true || (args as Record<string, unknown>).sign === false
    const signing = resolveSigningInputs({ repoRoot, disabled: noSign, binaryPath: args.binary ?? null, spawnSync: deps.spawnSync, exists: existsSync })

    let plan
    try {
      plan = planSelfDeploy({
        platform: process.platform,
        arch: process.arch,
        homeDir,
        uid,
        repoRoot,
        stateDir: STATE_DIR,
        plistXml,
        binary: args.binary,
        app: args.app,
        healthTimeoutMs: healthTimeout.value,
        // citty/mri turns `--no-rollback` into `rollback:false` (boolean
        // negation) — the declared `'no-rollback'` key stays undefined, so
        // reading only that key silently ignored the flag and deployed with
        // rollback still armed. Accept both spellings.
        rollback: !((args as Record<string, unknown>)['no-rollback'] === true || (args as Record<string, unknown>).rollback === false),
        ...signing,
        // 插件来源登记(2026-09-30):只在源码模式下有 checkout 可登记;打包版保留已有指针。
        pluginSourceCandidates: compiled ? [] : pluginSourceCandidates(repoRoot, deps.spawnSync),
        allowMissingPlugins: (args as Record<string, unknown>)['allow-missing-plugins'] === true || (args as Record<string, unknown>).allowMissingPlugins === true,
        allowUnsigned: (args as Record<string, unknown>)['allow-unsigned'] === true || (args as Record<string, unknown>).allowUnsigned === true,
        exists: existsSync,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // planSelfDeploy() can itself throw self_deploy_unsupported_platform
      // (defense in depth — the process.platform check above already
      // short-circuits the normal path) — keep both paths agreeing on exit 2.
      const exitCode = error === 'self_deploy_unsupported_platform' ? 2 : 1
      const message = error === 'launchagent_not_app_bundle'
        ? 'installed LaunchAgent does not point at an app bundle (looks like a dev-mode/source-checkout plist) — pass --app <path-to-.app> (e.g. "/Applications/Tendhearth CC.app") to target it explicitly'
        : error === 'launchagent_stale'
          ? 'installed LaunchAgent points at an app binary that no longer exists (the app was updated/renamed/moved) — open the app once (it repairs the LaunchAgent) or run `<app>/Contents/MacOS/tendhearth-cc-cli service repair`, then retry; or pass --app'
          : error
      if (json) console.log(JSON.stringify({ ok: false, exitCode, error, message }, null, 2))
      else console.error(`self deploy: ${message}`)
      process.exit(exitCode)
      return
    }

    const result = await executeSelfDeploy(plan, deps)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      for (const step of result.steps) {
        console.log(`${step.ok ? '✓' : '✗'} ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
      }
      if (result.ok) console.log(`✓ deployed${result.version ? ` (${result.version})` : ''}`)
      else {
        console.error(`✗ self deploy failed${result.rolledBack ? ' — rolled back to previous binary' : ''}`)
        if (result.diagnostics) console.error(result.diagnostics)
      }
    }
    process.exit(result.exitCode)
  },
})


// ── self change — 自改流水线:CC 自己给自己做一次改动 ──────────────────
//
// spec: docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md。
// 手册:docs/maintainer/self-change.md。这里只做四件事:解析开关、把配置合出来、
// 拿锁、把真件接上跑 run.ts —— 流水线本身一行都不在 cli.ts 里(它要能在没有
// citty、没有 process.argv 的测试里跑完整条)。
//
// 和 `self deploy` 一样是 darwin-only:最后两步(部署 + 自检)踩的是 launchd。

/** `--budget-usd`:钱的开关写错了当场报错,不替用户猜(同 parseTimeoutMsFlag 的理由)。 */

const selfChangeCmd = defineCommand({
  meta: { name: 'change', description: '自改流水线:执行者在专用克隆里实现 → 测试/评审/CI/主人拍板/合 dev → 部署 + 自检,不过就回滚(仅 macOS)' },
  args: {
    request: { type: 'positional', required: false, description: '需求原文(一句话说清要改什么)', valueHint: 'request' },
    resume: { type: 'string', description: '接着跑某条(`--list` 里的 id);拍板超时之后会重新发卡' },
    list: { type: 'boolean', description: '列最近 10 条自改的 id · 步骤 · 结果 · 起始时间' },
    unhalt: { type: 'boolean', description: '解除停机(清 halted_at / halt_reason,fail_streak 归零)' },
    approve: { type: 'string', description: '替某条(`--list` 里的 id)拍「放行」—— 微信外发不通时的第二条拍板口', valueHint: 'id' },
    deny: { type: 'string', description: '替某条拍「拒绝」', valueHint: 'id' },
    abandon: { type: 'string', description: '「这条我不接了」:把某条记成作废(不能再 --resume),当场删掉它的工作树;正在跑的那条拒绝', valueHint: 'id' },
    from: { type: 'string', default: 'cli', description: '进件口:cli | wechat(daemon 从微信接单时传 wechat)' },
    'budget-usd': { type: 'string', description: '这一条的实现预算上限,美元(覆盖 self_change.implement_budget_usd)' },
    deploy: { type: 'boolean', default: true, description: '合完 dev 之后部署 + 自检;`--no-deploy` 只合不部署' },
    json: { type: 'boolean', description: 'JSON 输出(整份 state),不输出人读版' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const bail = (exitCode: number, error: string, message: string): void => {
      if (json) console.log(JSON.stringify({ ok: false, exitCode, error, message }, null, 2))
      else console.error(`self change: ${message}`)
      process.exit(exitCode)
    }

    // run.ts 先进来:平台那一关也要用它的 exitCodeFor。退出码只有那张表说了算,
    // CLI 这边再写一遍 `2` 迟早和它对不上(哪天某个码从 blocked 挪走就穿帮)。
    const { exitCodeFor, runSelfChange } = await import('../self-change/run.ts')

    // 平台在最前面:流水线最后两步是 `self deploy` + 真机自检,两者都是 launchd 专属。
    if (process.platform !== 'darwin') {
      const error = 'self_change_unsupported_platform'
      bail(exitCodeFor(error), error, '自改流水线只支持 macOS(部署那一步是 launchd 专属)')
      return
    }

    const { resolveSelfChangeConfig, writeSelfChangeConfigPatch } = await import('../self-change/config.ts')
    const { acquireLock, makeStateStore, newSelfChangeId, newState } = await import('../self-change/state.ts')
    const { defaultPipelineDeps, formatSelfChangeSummary } = await import('../self-change/index.ts')

    const store = makeStateStore(STATE_DIR)

    // `--abandon` / `--list` 只要知道工作树在哪儿,不需要 repo_url(打包版没配也能用)。
    const { homedir } = await import('node:os')
    const { defaultWorkdir } = await import('../self-change/policy.ts')
    const workdir = loadAgentConfig(STATE_DIR).self_change?.workdir ?? defaultWorkdir(homedir(), process.platform)
    const { readLockHolder } = await import('../self-change/state.ts')

    // `--abandon <id>`:「这条我不接了」。顺手清理只敢扫 done / declined,能 --resume 的
    // 和被杀的永不回收 —— 这是人说了算的那个出口(见 abandon.ts 文件头)。
    if (args.abandon !== undefined) {
      if (args.approve !== undefined || args.deny !== undefined || args.list || args.unhalt || args.resume !== undefined || (typeof args.request === 'string' && args.request.trim() !== '')) {
        bail(1, 'invalid_flags', '--abandon 不能和 <需求> / --resume / --list / --unhalt / --approve / --deny 一起用')
        return
      }
      const id = String(args.abandon)
      const { runAbandon } = await import('../self-change/abandon.ts')
      const { hubPath } = await import('../self-change/steps.ts')
      const { spawnSync } = await import('node:child_process')
      const { makeGit, nodeGitSpawnSync } = await import('../self-change/git.ts')
      const { existsSync } = await import('node:fs')
      const outcome = runAbandon({
        store,
        config: { workdir },
        git: makeGit(nodeGitSpawnSync, workdir),
        exists: p => existsSync(p),
        now: () => Date.now(),
        lock: () => acquireLock(STATE_DIR, process.pid, undefined, undefined, id),
        liveHolder: () => readLockHolder(STATE_DIR),
        // gh 要在仓库里跑才认得出是哪个 repo:中枢克隆就是。
        closePr: (pr, comment) => {
          const r = spawnSync('gh', ['pr', 'close', String(pr), '--comment', comment], { cwd: hubPath({ workdir }), encoding: 'utf8', timeout: 60_000, windowsHide: true })
          if (r.status !== 0) console.error(`关 PR #${pr} 失败(不影响作废):${(r.stderr ?? '').trim().slice(0, 200)}`)
        },
      }, id)
      if (!outcome.ok) {
        bail(1, outcome.code, outcome.message)
        return
      }
      if (json) console.log(JSON.stringify({ ok: true, id, code: outcome.code, message: outcome.message }, null, 2))
      else console.log(outcome.message)
      process.exit(0)
      return
    }

    // `--approve <id>` / `--deny <id>`:微信外发不通时的第二条拍板口
    // (2026-09-18 真机:errcode=-2 让一条全绿的自改白等到 approval_timeout)。
    // daemon 侧现在发不出卡也**不删**待批条目,所以这里走的就是桌面那张权限卡
    // 同一条路由、同一个 consume —— 从哪边拍都算数。
    const verdictId = args.approve !== undefined ? String(args.approve) : args.deny !== undefined ? String(args.deny) : null
    if (verdictId !== null) {
      // 和别的口互斥:`--approve x --list` 到底是哪个意思,猜不得。
      if (args.approve !== undefined && args.deny !== undefined) {
        bail(1, 'invalid_flags', '--approve 和 --deny 只能给一个')
        return
      }
      if (args.list || args.unhalt || args.resume !== undefined || (typeof args.request === 'string' && args.request.trim() !== '')) {
        bail(1, 'invalid_flags', '--approve / --deny 不能和 <需求> / --resume / --list / --unhalt 一起用')
        return
      }
      const decision = args.approve !== undefined ? 'allow' as const : 'deny' as const
      const { runApprove } = await import('../self-change/approve.ts')
      const { makeDaemonClient } = await import('../self-change/daemon-client.ts')
      const { readApiInfo } = await import('../../lib/api-info.ts')
      const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(STATE_DIR), fetch })
      const verdict = await runApprove(store, daemon, verdictId, decision)
      if (!verdict.ok) {
        bail(1, verdict.code, verdict.message)
        return
      }
      if (json) console.log(JSON.stringify({ ok: true, id: verdictId, decision, message: verdict.message }, null, 2))
      else console.log(verdict.message)
      process.exit(0)
      return
    }

    // `--unhalt`:给 undefined 等于把键删掉(JSON.stringify 不序列化 undefined)。
    if (args.unhalt) {
      try {
        writeSelfChangeConfigPatch(STATE_DIR, { halted_at: undefined, halt_reason: undefined, fail_streak: 0 })
      } catch (err) {
        // 配置文件读不出来 ⇒ 拒写(不拿缺省值覆盖主人的配置);说一句人话、非零退出。
        const msg = err instanceof Error ? err.message : String(err)
        if (json) console.log(JSON.stringify({ ok: false, error: (err as { code?: string }).code ?? 'error', detail: msg }, null, 2))
        else console.error(`没能解除自改停机:${msg}`)
        process.exit(1)
        return
      }
      if (json) console.log(JSON.stringify({ ok: true, unhalted: true }, null, 2))
      else console.log('自改停机已解除:halted_at / halt_reason 清掉,fail_streak 归零。')
      process.exit(0)
      return
    }

    if (args.list) {
      // 每条带上「在跑 / 被杀 / 可 --resume / 已收场 / 已作废」和盘上的工作树路径:
      // 哪些树还占着盘、哪些可以 --abandon,一眼看得出来。
      const { describeRuns, formatRunRows } = await import('../self-change/abandon.ts')
      const { existsSync } = await import('node:fs')
      const rows = describeRuns(store.list().slice(0, 10), { config: { workdir }, exists: p => existsSync(p), live: readLockHolder(STATE_DIR) })
      if (json) {
        console.log(JSON.stringify(rows.map(r => ({ id: r.id, step: r.step, result: r.result, startedAt: r.startedAt, kind: r.kind, tree: r.tree })), null, 2))
      } else if (rows.length === 0) {
        console.log('还没有跑过自改。')
      } else {
        console.log(formatRunRows(rows))
      }
      process.exit(0)
      return
    }

    const budget = parseBudgetUsdFlag(args['budget-usd'])
    if (!budget.ok) {
      bail(1, 'invalid_budget_usd', `--budget-usd ${budget.error}`)
      return
    }
    const from = args.from === undefined ? 'cli' : String(args.from)
    if (from !== 'cli' && from !== 'wechat') {
      bail(1, 'invalid_from', `--from ${from}(只认 cli 或 wechat)`)
      return
    }

    // `--resume` 接着跑的是**存盘里的那一条**:需求、分支、已经花掉的钱、
    // 修复轮次数都在里面,这里不能拿命令行再覆盖一遍。
    const resumed = args.resume === undefined ? null : store.load(String(args.resume))
    if (args.resume !== undefined && !resumed) {
      bail(1, 'self_change_not_found', `没有这条自改:${String(args.resume)}(wechat-cc self change --list 看有哪些)`)
      return
    }
    // 主人 `--abandon` 过的:树已经删了,这是他拍的终局。要做同样的事就重新下一条。
    if (resumed && resumed.result === 'abandoned') {
      bail(1, 'self_change_abandoned', `#${resumed.id} 已经作废了(--abandon),不能再接着跑;要做同样的事请重新下一条`)
      return
    }
    const request = typeof args.request === 'string' ? args.request.trim() : ''
    // `--resume` 又带了需求正文:照存盘里的跑,但得说一声 —— 人多半以为自己
    // 是在「接着跑并且顺手改一下要求」,闷着不响他会等一个永远不会发生的行为。
    if (resumed && request) {
      console.error(`self change: --resume 用存盘里的需求,命令行上这句忽略了(存盘:${resumed.request.slice(0, 60)})`)
    }
    if (!resumed && !request) {
      bail(1, 'request_required', '要改什么?例:wechat-cc self change "在 ci-and-flakes.md 的 flake 表里加一行"')
      return
    }

    // 克隆哪个仓库:源码模式问自己的 origin;打包版没有 checkout 可问,
    // 只能要求主人在 agent-config.json 里写 self_change.repo_url。
    const repoRoot = isCompiledBundle() ? null : SOURCE_REPO_ROOT
    let originUrl: string | null = null
    if (repoRoot) {
      const { makeGit, nodeGitSpawnSync } = await import('../self-change/git.ts')
      const r = makeGit(nodeGitSpawnSync, repoRoot).run(['remote', 'get-url', 'origin'])
      originUrl = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
    }

    const resolved = resolveSelfChangeConfig({
      agent: loadAgentConfig(STATE_DIR).self_change,
      homeDir: homedir(),
      platform: process.platform,
      originUrl,
      ...(budget.value === undefined ? {} : { overrides: { implementBudgetUsd: budget.value } }),
    })
    if (!resolved.ok) {
      // blocked(2)而不是 failed(1):不是这次改动的错,重跑同样的需求没有
      // 意义 —— 得先有人去配。码归哪一档由 exitCodeFor 那张表说了算。
      bail(exitCodeFor(resolved.error), resolved.error, '不知道该克隆哪个仓库:打包版请在 agent-config.json 里写 self_change.repo_url(源码模式会问 git remote get-url origin)')
      return
    }

    // 一次只跑一条。锁文件里写着 pid 和**在跑哪条**(`--abandon` 靠它分清能不能作废),
    // 持有者死了会被抢过来(见 state.ts)。id 因此要在拿锁之前定下来。
    const runId = resumed?.id ?? newSelfChangeId()
    const lock = acquireLock(STATE_DIR, process.pid, undefined, undefined, runId)
    if (!lock.ok) {
      const error = 'self_change_busy'
      bail(exitCodeFor(error), error, `已经有一条自改在跑(pid ${lock.holder});等它结束,或者先 wechat-cc self change --list 看看`)
      return
    }

    // 恢复的那条在拿到锁之后再从盘上读一遍:等锁之前它可能刚被 `--abandon` 掉
    // (那样的话 runSelfChange 会原样退回,不跑)。
    const state = (resumed ? store.load(resumed.id) ?? resumed : null) ?? newState({
      id: runId,
      request,
      from,
      noDeploy: args.deploy === false,
      now: Date.now(),
    })

    let outcome: Awaited<ReturnType<typeof runSelfChange>> | null = null
    let crashed: unknown = null
    try {
      outcome = await runSelfChange(state, defaultPipelineDeps(STATE_DIR, resolved.config, { repoRoot, runId: state.id }))
    } catch (err) {
      crashed = err
    } finally {
      // process.exit 之后 finally 不会跑,所以锁必须在这儿先还回去。
      lock.release()
    }
    if (!outcome) {
      bail(1, 'self_change_crashed', crashed instanceof Error ? `${crashed.message}\n${crashed.stack ?? ''}`.trim() : String(crashed))
      return
    }

    if (json) console.log(JSON.stringify(outcome.state, null, 2))
    else console.log(formatSelfChangeSummary(outcome.state))
    process.exit(outcome.exitCode)
  },
})

// ── self soak — 这一次部署稳不稳、能不能放下一步(src/cli/self-soak.ts 开头写了判法) ──
const selfSoakCmd = defineCommand({
  meta: { name: 'soak', description: '这次部署在真机上稳不稳:从最后一次 self deploy 算起看日志里的意外重启 / 模块失败 / 崩溃,和健康接口;只读' },
  args: {
    since: { type: 'string', description: '从哪个时间算起(ISO;缺省 = 日志里最后一次 self deploy 的重启)' },
    'min-hours': { type: 'string', description: '至少跑几小时才放行(缺省 4)' },
    'min-restarts': { type: 'string', description: '部署后至少优雅重启过几次(缺省 0;改到关机顺序的给 1)' },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const { readFileSync, existsSync } = await import('node:fs')
    const { readApiInfo } = await import('../../lib/api-info')
    const { LOG_FILE } = await import('../../lib/log')
    const { judgeSoak, formatSoak, SOAK_EXIT } = await import('../self-soak')
    const num = (raw: unknown, dflt: number) => (raw === undefined || raw === '' ? dflt : Number(raw))
    const minHours = num(args['min-hours'], 4)
    const minRestarts = num(args['min-restarts'], 0)
    const since = args.since ? Date.parse(String(args.since)) : undefined
    if (!Number.isFinite(minHours) || minHours < 0 || !Number.isInteger(minRestarts) || minRestarts < 0 || (since !== undefined && !Number.isFinite(since))) {
      console.error('self soak: 用法 wechat-cc self soak [--since <ISO>] [--min-hours N] [--min-restarts N] [--json]')
      process.exit(SOAK_EXIT.red)
      return
    }
    const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
    const log = read(`${LOG_FILE}.1`) + read(LOG_FILE)
    let health = null
    const info = readApiInfo(STATE_DIR)
    if (info) {
      try {
        const res = await fetch(`${info.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(5000) })
        if (res.ok) health = await res.json()
      } catch { /* 不通 ⇒ health 为 null,判红 */ }
    }
    const report = judgeSoak({ log, health, now: Date.now(), ...(since !== undefined ? { since } : {}), minHours, minRestarts })
    console.log(args.json ? JSON.stringify(report, null, 2) : formatSoak(report))
    process.exit(SOAK_EXIT[report.verdict])
  },
})

// ── self ship — 一批合进 dev 之后的部署门(src/cli/self-ship.ts 开头写了顺序和为什么) ──
const selfShipCmd = defineCommand({
  meta: { name: 'ship', description: '部署门:负载 → 网络守护 → 构建 sidecar → self deploy → 自检(红了回滚);之后看 self soak(仅 macOS 源码模式)' },
  args: {
    'wait-min': { type: 'string', description: '机器忙时最多等几分钟(缺省 0:忙就不动)' },
    'max-load': { type: 'string', description: '1 分钟负载 / 核数的上限(缺省 1.0)' },
    'skip-build': { type: 'boolean', description: '不构建,直接部署已经构建好的 sidecar' },
    'allow-off-dev': { type: 'boolean', description: 'HEAD 不是 origin/dev 也装(试一条分支);脏树永远不装' },
  },
  async run({ args }) {
    const { runShip, SHIP_EXIT, DEFAULT_MAX_LOAD_PER_CPU } = await import('../self-ship')
    if (process.platform !== 'darwin' || isCompiledBundle()) {
      console.error('self ship: 只在 macOS 源码模式下跑(要在仓库里构建 sidecar);打包版用 self deploy --binary')
      process.exit(SHIP_EXIT.deploy_failed)
      return
    }
    const num = (raw: unknown, dflt: number) => (raw === undefined || raw === '' ? dflt : Number(raw))
    const waitMin = num(args['wait-min'], 0)
    const maxLoadPerCpu = num(args['max-load'], DEFAULT_MAX_LOAD_PER_CPU)
    if (!Number.isFinite(waitMin) || waitMin < 0 || !Number.isFinite(maxLoadPerCpu) || maxLoadPerCpu <= 0) {
      console.error('self ship: 用法 wechat-cc self ship [--wait-min N] [--max-load X] [--skip-build] [--allow-off-dev]')
      process.exit(SHIP_EXIT.deploy_failed)
      return
    }
    const { loadavg, cpus } = await import('node:os')
    const { readApiInfo } = await import('../../lib/api-info')
    const { makeDaemonClient } = await import('../self-change/daemon-client')
    const { deployFromRepo, makeSelftest } = await import('../self-change/index')
    const { spawnCollect } = await import('../self-change/runner')
    const { SELF_CHANGE_DEFAULTS } = await import('../self-change/policy')
    const { defaultSelftestDeps, runChatSelftest, runWorkbenchSelftest } = await import('../selftest')
    const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(STATE_DIR), fetch })
    const agent = loadAgentConfig(STATE_DIR).self_change
    const { spawnSync } = await import('node:child_process')
    const git = (...a: string[]) => spawnSync('git', a, { cwd: SOURCE_REPO_ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    const res = await runShip({
      tree: () => {
        // fetch 不成就用本地的 origin/dev(多半旧一点 ⇒ 对不上就拒,宁严勿松)。
        git('fetch', '-q', 'origin', 'dev')
        const dev = git('rev-parse', '--verify', '-q', 'origin/dev')
        return { dirty: git('status', '--porcelain').stdout ?? '', head: (git('rev-parse', 'HEAD').stdout ?? '').trim(), devHead: dev.status === 0 ? dev.stdout.trim() : null }
      },
      load: () => ({ load1: loadavg()[0] ?? 0, cpus: cpus().length }),
      guard: () => daemon.guard(),
      build: async () => {
        const r = await spawnCollect('bun', ['run', 'build-sidecar'], { cwd: join(SOURCE_REPO_ROOT, 'apps', 'desktop'), env: process.env, timeoutMs: SELF_CHANGE_DEFAULTS.tests_timeout_ms })
        return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n') }
      },
      deploy: mode => deployFromRepo(STATE_DIR, SOURCE_REPO_ROOT, mode),
      // 跟自改同一套自检、同一份配置(agent-config 的 self_change.selftest_executor / selftest_provider)。
      selftest: makeSelftest({
        selftestExecutor: agent?.selftest_executor ?? SELF_CHANGE_DEFAULTS.selftest_executor,
        selftestProvider: agent?.selftest_provider ?? SELF_CHANGE_DEFAULTS.selftest_provider,
      }, {
        workbench: o => runWorkbenchSelftest(defaultSelftestDeps(STATE_DIR), o),
        chat: o => runChatSelftest(defaultSelftestDeps(STATE_DIR), o),
      }),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      now: () => Date.now(),
      log: line => console.error(line),
    }, { waitMin, maxLoadPerCpu, skipBuild: Boolean(args['skip-build']), allowOffDev: Boolean(args['allow-off-dev']) })
    ;(res.exitCode === SHIP_EXIT.shipped ? console.log : console.error)(res.message)
    process.exit(res.exitCode)
  },
})

// ── self plan — 开发目标 → 计划(拆几个 PR、先后、哪些主人看得见;src/cli/self-plan.ts 开头写了为什么) ──
const selfPlanCmd = defineCommand({
  meta: { name: 'plan', description: '规划者:把一个开发目标拆成 PR 列表(先后依赖、哪些主人看得见要先点头);只读,不执行' },
  args: {
    goal: { type: 'positional', required: false, description: '开发目标(一句话)' },
    planner: { type: 'string', description: '谁来规划:claude(缺省)/ codex' },
    'with-discover': { type: 'boolean', description: '把 self discover 的 roadmap / 守卫基线 / 自改教训候选一起交给规划者(日志那一源不交:里面可能有联系人昵称)' },
    show: { type: 'string', description: '看一份存下的计划', valueHint: 'id' },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const plansDir = join(STATE_DIR, 'self-plans')
    if (args.show) {
      const p = join(plansDir, `${String(args.show)}.json`)
      if (!existsSync(p)) { console.error(`没有这份计划:${String(args.show)}`); process.exit(1); return }
      const { formatPlan } = await import('../self-plan')
      const { readJsonFile } = await import('../../lib/read-json-file')
      const saved = readJsonFile<{ order: string[] } & import('../self-plan').DevPlan>(p)
      console.log(args.json ? JSON.stringify(saved, null, 2) : formatPlan(saved, saved.order))
      return
    }
    const goal = String(args.goal ?? '').trim()
    if (!goal) { console.error('self plan: 用法 wechat-cc self plan "<开发目标>" [--planner claude|codex] [--with-discover] [--json];看存下的:--show <id>'); process.exit(1); return }
    const planner = String(args.planner ?? 'claude')
    if (!['claude', 'codex'].includes(planner)) { console.error('self plan: --planner 只认 claude / codex'); process.exit(1); return }

    const { resolveSelfChangeConfig } = await import('../self-change/config')
    const { makeGit, nodeGitSpawnSync } = await import('../self-change/git')
    const repoRoot = isCompiledBundle() ? null : SOURCE_REPO_ROOT
    const origin = repoRoot ? makeGit(nodeGitSpawnSync, repoRoot).run(['remote', 'get-url', 'origin']) : null
    const resolved = resolveSelfChangeConfig({ agent: loadAgentConfig(STATE_DIR).self_change, homeDir: homedir(), platform: process.platform, originUrl: origin?.code === 0 ? origin.stdout.trim() || null : null })
    if (!resolved.ok) { console.error('不知道该克隆哪个仓库:打包版请在 agent-config.json 里写 self_change.repo_url'); process.exit(2); return }
    const config = resolved.config

    // 候选:只交 roadmap 和守卫基线(没有人的数据);日志里可能有联系人昵称,redact 抹不掉(self-change.md 已知限制)。
    let candidates: string | undefined
    if (args['with-discover'] && repoRoot) {
      const { roadmapOpenItems, formatRoadmapItems } = await import('../self-discover-roadmap')
      const { ratchetDebts, formatRatchetDebts } = await import('../self-discover-ratchets')
      const scripts = join(repoRoot, 'scripts')
      const roadmap = join(repoRoot, 'docs', 'roadmap.md')
      candidates = [
        existsSync(roadmap) ? formatRoadmapItems(roadmapOpenItems(readFileSync(roadmap, 'utf8'))) : '',
        existsSync(scripts) ? formatRatchetDebts(ratchetDebts(readdirSync(scripts).filter(f => f.endsWith('.guard.test.ts')).map(f => ({ path: `scripts/${f}`, text: readFileSync(join(scripts, f), 'utf8') })))) : '',
        // 自改的教训账也交:只有流水线自己的输出(测试 / 评审 / CI 的几行、结局码),没有人的数据。
        await (async () => {
          const { lessonCandidates, formatLessonCandidates, SELF_LESSONS_FILE } = await import('../self-change/lessons')
          const p = join(STATE_DIR, SELF_LESSONS_FILE)
          return existsSync(p) ? formatLessonCandidates(lessonCandidates(readFileSync(p, 'utf8'))) : ''
        })(),
      ].filter(Boolean).join('\n\n')
    }

    const { readApiInfo } = await import('../../lib/api-info')
    const { makeDaemonClient } = await import('../self-change/daemon-client')
    const { guardedRunner, makeClaudeRunner, makeCodexReviewRunner, spawnCollect } = await import('../self-change/runner')
    const { newSelfChangeId } = await import('../self-change/state')
    const { runPlan } = await import('../self-plan')
    const daemon = makeDaemonClient({ readApiInfo: () => readApiInfo(STATE_DIR), fetch })
    // 规划者打的是官方端点:先过网络守护(跟实现 / 评审同一道)。
    const inner = planner === 'codex' ? makeCodexReviewRunner({ launch: spawnCollect, env: process.env }) : makeClaudeRunner({ launch: spawnCollect, env: process.env })
    const id = newSelfChangeId()
    console.error(`规划中(${planner},只读)…计划号 ${id}`)
    const res = await runPlan({
      git: makeGit(nodeGitSpawnSync, config.workdir),
      runner: guardedRunner(inner, () => daemon.guard()),
      exists: p => existsSync(p),
      mkdirp: p => { mkdirSync(p, { recursive: true }) },
      writeFile: (p, t) => { writeFileSync(p, t) },
      now: () => Date.now(),
      log: l => console.error(l),
      workdir: config.workdir, repoUrl: config.repoUrl, branch: config.branch, plansDir,
      budgetUsd: config.reviewBudgetUsd, maxTurns: config.maxTurns,
    }, { id, goal, ...(candidates ? { candidates } : {}) })
    if (args.json) console.log(JSON.stringify(res, null, 2))
    else console.log(res.ok ? `${res.message}\n\n存在 ${res.path}(wechat-cc self plan --show ${id});花了 $${res.costUsd.toFixed(2)}。每个 PR 用 wechat-cc self change "<那一条>" 去做。` : res.message)
    process.exit(res.ok ? 0 : 1)
  },
})

// ── self discover — 找活:真机日志里反复出现的失败 + roadmap 上没标完成的欠账 / 对标(src/cli/self-discover*.ts 开头写了判法) ──
const selfDiscoverCmd = defineCommand({
  meta: { name: 'discover', description: '发掘任务:日志里反复出现的失败(按次数)+ roadmap 欠账 / 对标里没标完成的 + 守卫里只许降的基线;只读' },
  args: {
    hours: { type: 'string', description: '日志看最近几小时(缺省 48)' },
    'min-count': { type: 'string', description: '日志里至少出现几次才算(缺省 3)' },
    source: { type: 'string', description: 'log / roadmap / ratchets / lessons / all(缺省 all)' },
    json: { type: 'boolean', description: 'JSON 输出({ log, roadmap, ratchets, lessons })' },
  },
  async run({ args }) {
    const { readFileSync, existsSync } = await import('node:fs')
    const { LOG_FILE } = await import('../../lib/log')
    const { discover, formatDiscover } = await import('../self-discover')
    const { roadmapOpenItems, formatRoadmapItems } = await import('../self-discover-roadmap')
    const { ratchetDebts, formatRatchetDebts } = await import('../self-discover-ratchets')
    const hours = args.hours === undefined || args.hours === '' ? 48 : Number(args.hours)
    const minCount = args['min-count'] === undefined || args['min-count'] === '' ? 3 : Number(args['min-count'])
    const source = String(args.source ?? 'all')
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isInteger(minCount) || minCount < 1 || !['log', 'roadmap', 'ratchets', 'lessons', 'all'].includes(source)) {
      console.error('self discover: 用法 wechat-cc self discover [--hours N] [--min-count N] [--source log|roadmap|ratchets|lessons|all] [--json]')
      process.exit(1)
      return
    }
    const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
    const { lastDeployAt } = await import('../self-soak')
    const logText = read(`${LOG_FILE}.1`) + read(LOG_FILE)
    // 「部署后还有几次」:48 小时的总数会把已经修好的那类排在前面(10-23 agy 被拒,#627 部署后从每小时 1.7 次降到退避节奏)。
    const want = (k: string) => source === 'all' || source === k
    const log = !want('log') ? null : discover({ log: logText, now: Date.now(), hours, minCount, deployedAt: lastDeployAt(logText) })
    // 打包版旁边没有仓库:roadmap 这一源照实说读不到,不当成「没有欠账」。
    const roadmapPath = isCompiledBundle() ? null : join(SOURCE_REPO_ROOT, 'docs', 'roadmap.md')
    const roadmap = !want('roadmap') ? null : roadmapPath && existsSync(roadmapPath) ? roadmapOpenItems(readFileSync(roadmapPath, 'utf8')) : null
    const scriptsDir = isCompiledBundle() ? null : join(SOURCE_REPO_ROOT, 'scripts')
    const { readdirSync } = await import('node:fs')
    const ratchets = !want('ratchets') || !scriptsDir || !existsSync(scriptsDir) ? null
      : ratchetDebts(readdirSync(scriptsDir).filter(f => f.endsWith('.guard.test.ts')).map(f => ({ path: `scripts/${f}`, text: readFileSync(join(scriptsDir, f), 'utf8') })))
    const { lessonCandidates, formatLessonCandidates, SELF_LESSONS_FILE } = await import('../self-change/lessons')
    const lessonsPath = join(STATE_DIR, SELF_LESSONS_FILE)
    const lessons = !want('lessons') ? null : lessonCandidates(existsSync(lessonsPath) ? readFileSync(lessonsPath, 'utf8') : '')
    if (args.json) {
      console.log(JSON.stringify({ log, roadmap, ratchets, lessons }, null, 2))
      return
    }
    const parts: string[] = []
    if (log) parts.push(formatDiscover(log, hours))
    if (want('roadmap')) parts.push(roadmap ? formatRoadmapItems(roadmap) : '读不到 docs/roadmap.md(打包版旁边没有仓库),欠账 / 对标这一源没看。')
    if (lessons) parts.push(formatLessonCandidates(lessons))
    if (want('ratchets')) parts.push(ratchets ? formatRatchetDebts(ratchets) : '读不到 scripts/(打包版旁边没有仓库),守卫基线这一源没看。')
    console.log(parts.join('\n\n'))
  },
})

export const selfCmd = defineCommand({
  meta: { name: 'self', description: '自维护:部署自身、让 CC 自己改自己（仅 macOS launchd；见 docs/maintainer/deploy.md 与 self-change.md）' },
  subCommands: { change: selfChangeCmd, deploy: selfDeployCmd, ship: selfShipCmd, soak: selfSoakCmd, discover: selfDiscoverCmd, plan: selfPlanCmd },
})
