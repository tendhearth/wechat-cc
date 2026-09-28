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
    'no-sign': { type: 'boolean', description: '不用本机钥匙串里的 Developer ID 重签 sidecar 与 .app(缺省:有证书就签)' },
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

    const { planSelfDeploy, executeSelfDeploy, defaultSelfDeployDeps, resolveSigningInputs } = await import('../self-deploy.ts')
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
    const signing = resolveSigningInputs({ repoRoot, disabled: noSign, spawnSync: deps.spawnSync, exists: existsSync })

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
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // planSelfDeploy() can itself throw self_deploy_unsupported_platform
      // (defense in depth — the process.platform check above already
      // short-circuits the normal path) — keep both paths agreeing on exit 2.
      const exitCode = error === 'self_deploy_unsupported_platform' ? 2 : 1
      const message = error === 'launchagent_not_app_bundle'
        ? 'installed LaunchAgent does not point at an app bundle (looks like a dev-mode/source-checkout plist) — pass --app <path-to-wechat-cc.app> to target it explicitly'
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
      writeSelfChangeConfigPatch(STATE_DIR, { halted_at: undefined, halt_reason: undefined, fail_streak: 0 })
      if (json) console.log(JSON.stringify({ ok: true, unhalted: true }, null, 2))
      else console.log('自改停机已解除:halted_at / halt_reason 清掉,fail_streak 归零。')
      process.exit(0)
      return
    }

    if (args.list) {
      const rows = store.list().slice(0, 10)
      if (json) {
        console.log(JSON.stringify(rows.map(s => ({ id: s.id, step: s.step, result: s.result, startedAt: s.startedAt })), null, 2))
      } else if (rows.length === 0) {
        console.log('还没有跑过自改。')
      } else {
        for (const s of rows) {
          // 停在 approval 的那条要一眼看得出来:它在等人,而不是在跑
          // (微信卡可能根本没送到 —— 见 `--approve`)。
          const status = s.result ?? (s.step === 'approval' ? '等拍板 ' + String(s.approval?.hash ?? '').slice(0, 8) : '进行中')
          console.log(`${s.id} · ${s.step} · ${status} · ${new Date(s.startedAt).toISOString()}`)
        }
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

    const { homedir } = await import('node:os')
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

    // 一次只跑一条。锁文件里写着 pid,持有者死了会被抢过来(见 state.ts)。
    const lock = acquireLock(STATE_DIR, process.pid)
    if (!lock.ok) {
      const error = 'self_change_busy'
      bail(exitCodeFor(error), error, `已经有一条自改在跑(pid ${lock.holder});等它结束,或者先 wechat-cc self change --list 看看`)
      return
    }

    const state = resumed ?? newState({
      id: newSelfChangeId(),
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

export const selfCmd = defineCommand({
  meta: { name: 'self', description: '自维护:部署自身、让 CC 自己改自己（仅 macOS launchd；见 docs/maintainer/deploy.md 与 self-change.md）' },
  subCommands: { change: selfChangeCmd, deploy: selfDeployCmd },
})
