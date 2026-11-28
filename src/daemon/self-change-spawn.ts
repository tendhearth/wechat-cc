/**
 * 微信「自改 <需求>」的执行端:把 `wechat-cc self change` 作为**独立进程**拉起来,
 * 再读回它写下的状态文件。
 *
 * 为什么不在 daemon 里直接跑流水线:自改最后两步是部署 + 自检,会把**当前这个
 * daemon** 停掉再拉起来 —— 跑在 daemon 进程里等于自己锯自己坐的那根树枝(同
 * `updateSelf` 的理由)。所以 detached + stdio:'ignore' + unref():父进程死了
 * 孩子照跑,进展经微信卡片回来。
 *
 * 为什么状态列表在这儿又抄了一遍(`src/cli/self-change/state.ts` 里明明有 `list()`):
 * 分层规矩是 daemon ↛ cli,而那份 store 还带着写入、锁、配额。这里只要只读的四个
 * 字段,抄十行比把 cli 拽进 daemon 便宜得多 —— 文件格式是两边共同的契约,
 * 读坏了当没有(一条烂记录不该让「自改 状态」整个瘫掉)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawn as SpawnFn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isCompiledBundle } from '../lib/runtime-info'
import { findOnPath } from '../lib/util'
import { workbenchSubprocessEnv } from '../adapters/executors/subprocess-env'

/** 「自改 状态」要显示的四个字段。和 `src/cli/self-change/state.ts` 的 SelfChangeState 同名同义。 */
export interface SelfChangeRow {
  id: string
  step: string
  result: string | null
  startedAt: number
}

export type SelfCliResolution =
  | { cmd: string; args: string[] }
  | { error: 'self_cli_not_found' | 'bun_not_found' }

/**
 * 找到「我自己的命令行」:打包版是并排的 `wechat-cc-cli` 二进制,源码版是
 * `bun <repo>/cli.ts`。纯函数 —— 平台判断、execPath、PATH 查找全部由调用方注入,
 * 这样三种情形(源码 / 打包 / 找不到)在测试里能各演一遍。
 */
export function resolveSelfCli(input: {
  compiled: boolean
  execPath: string
  repoRoot: string
  bunPath: string | null
  exists: (p: string) => boolean
}): SelfCliResolution {
  if (input.compiled) {
    // 打包版:sidecar 自己就是那个命令行(`tendhearth-cc-cli`,老包 `wechat-cc-cli`)。
    // 用 execPath 自己的名字而不是写死:1.7.5 起 macOS 换了名,写死旧名 ⇒ self_cli_not_found。
    const binary = join(dirname(input.execPath), basename(input.execPath))
    if (!input.exists(binary)) return { error: 'self_cli_not_found' }
    return { cmd: binary, args: [] }
  }
  const entry = join(input.repoRoot, 'cli.ts')
  if (!input.exists(entry)) return { error: 'self_cli_not_found' }
  // bun 的检查放在 cli.ts 之后:两者都缺的时候,先说「没找到自己的代码」更贴近真相。
  if (!input.bunPath) return { error: 'bun_not_found' }
  return { cmd: input.bunPath, args: [entry] }
}

/** 解析失败的机器码 → 主人能看懂的一句话(微信里直接念给他听)。 */
const RESOLVE_REASON: Record<'self_cli_not_found' | 'bun_not_found', string> = {
  self_cli_not_found: '找不到 wechat-cc 自己的命令行入口(self_cli_not_found)',
  bun_not_found: 'PATH 里没有 bun(bun_not_found)',
}

export interface SelfChangeSpawner {
  start(request: string): { ok: true; pid: number } | { ok: false; reason: string }
  autoship(): ReturnType<SelfChangeSpawner['start']>
  list(): SelfChangeRow[]
}

export function makeSelfChangeSpawner(deps: {
  resolve: () => SelfCliResolution
  spawn: typeof SpawnFn
  env: NodeJS.ProcessEnv
  stateDir: string
  log: (line: string) => void
  /** 子进程的工作目录。缺省继承 daemon 的 —— 命令行入口走的是绝对路径,不依赖它。 */
  cwd?: string
  /** 只读状态目录的口子;测试可以塞假件。 */
  fs?: { readdirSync: (dir: string) => string[]; readFileSync: (p: string) => string }
}): SelfChangeSpawner {
  const fs = deps.fs ?? {
    readdirSync: (dir: string) => readdirSync(dir),
    readFileSync: (p: string) => readFileSync(p, 'utf8'),
  }
  const dir = join(deps.stateDir, 'self-change')

  function start(args: string[], kind: 'self-change' | 'autoship', text?: string): ReturnType<SelfChangeSpawner['start']> {
    const resolved = deps.resolve()
    if ('error' in resolved) {
      deps.log(`${kind} start refused: ${resolved.error}`)
      return { ok: false, reason: RESOLVE_REASON[resolved.error] }
    }

    const env = workbenchSubprocessEnv(deps.env)
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    // 自动轮只用 daemon 已经选定的状态目录；仍不继承凭据。
    if (kind === 'autoship') env.WECHAT_STATE_DIR = deps.stateDir

    try {
      const child = deps.spawn(resolved.cmd, [...resolved.args, ...args], {
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      child.once('error', err => deps.log(`${kind} child error: ${err.message}`))
      if (typeof child.pid !== 'number') {
        deps.log(`${kind} start failed: no pid`)
        return { ok: false, reason: '子进程没起来(没拿到 pid)' }
      }
      child.unref()
      deps.log(`${kind} started pid=${child.pid}${text ? ` request="${text.slice(0, 60)}"` : ''}`)
      return { ok: true, pid: child.pid }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.log(`${kind} start threw: ${detail}`)
      return { ok: false, reason: detail.slice(0, 160) }
    }
  }

  return {
    start(request) {
      const text = request.trim()
      if (!text) return { ok: false, reason: '没说要改什么' }
      // 需求以 `-` 开头时也必须作为原文交给 CLI。
      return start(['self', 'change', '--from', 'wechat', '--json', '--', text], 'self-change', text)
    },

    autoship() {
      return start(['self', 'autoship'], 'autoship')
    },

    list() {
      let names: string[]
      try { names = fs.readdirSync(dir) } catch { return [] }
      const rows: SelfChangeRow[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(join(dir, name)))
          if (typeof parsed !== 'object' || parsed === null) continue
          const s = parsed as { id?: unknown; step?: unknown; result?: unknown; startedAt?: unknown }
          if (typeof s.id !== 'string' || typeof s.startedAt !== 'number') continue
          rows.push({
            id: s.id,
            step: typeof s.step === 'string' ? s.step : '?',
            result: typeof s.result === 'string' ? s.result : null,
            startedAt: s.startedAt,
          })
        } catch { /* 一条烂记录不该让整张列表瘫掉 */ }
      }
      return rows.sort((a, b) => b.startedAt - a.startedAt)
    },
  }
}

/** 编译产物的源码目录在 Bun 虚拟文件系统里，不能用它做 cwd。 */
export function defaultSelfChangeSpawner(stateDir: string, log: (line: string) => void): SelfChangeSpawner {
  const compiled = isCompiledBundle()
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return makeSelfChangeSpawner({
    resolve: () => resolveSelfCli({
      compiled, execPath: process.execPath, repoRoot: root,
      bunPath: compiled ? null : findOnPath('bun'), exists: existsSync,
    }),
    spawn: SpawnFn, env: process.env, stateDir, cwd: compiled ? dirname(process.execPath) : root, log,
  })
}
