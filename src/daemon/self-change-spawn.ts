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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { spawn as SpawnFn } from 'node:child_process'
import { workbenchSubprocessEnv } from '../core/workbench/subprocess-env'

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
    // 打包版:sidecar 自己就是 wechat-cc-cli,和它并排的那个才是要再起一份的目标。
    const binary = join(dirname(input.execPath), 'wechat-cc-cli')
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

  return {
    start(request) {
      const text = request.trim()
      if (!text) return { ok: false, reason: '没说要改什么' }

      const resolved = deps.resolve()
      if ('error' in resolved) {
        deps.log(`self-change start refused: ${resolved.error}`)
        return { ok: false, reason: RESOLVE_REASON[resolved.error] }
      }

      // daemon 的凭据一律不进子进程(workbenchSubprocessEnv);另外把 Claude Code
      // 自己的在场标记删掉 —— 开发期 daemon 常常是从 Claude Code 里起来的,而流水线
      // 里要 spawn `claude -p`,带着 CLAUDECODE 进去会被当成嵌套会话直接拒绝。
      const env = workbenchSubprocessEnv(deps.env)
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRYPOINT

      try {
        const child = deps.spawn(
          resolved.cmd,
          [...resolved.args, 'self', 'change', '--from', 'wechat', '--json', text],
          {
            ...(deps.cwd ? { cwd: deps.cwd } : {}),
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env,
          },
        )
        if (typeof child.pid !== 'number') {
          deps.log('self-change start failed: no pid')
          return { ok: false, reason: '子进程没起来(没拿到 pid)' }
        }
        child.unref()
        deps.log(`self-change started pid=${child.pid} request="${text.slice(0, 60)}"`)
        return { ok: true, pid: child.pid }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        deps.log(`self-change start threw: ${detail}`)
        return { ok: false, reason: detail.slice(0, 160) }
      }
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
