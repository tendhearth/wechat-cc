/**
 * jobspawn.ts —— 「杀掉整棵进程树」在 Windows 上成立所需要的那一层包装,TS 侧的接缝。
 *
 * Windows 没有进程组,于是产品里十几处 `process.kill(-pid, sig)` 在 win32 上一律退化
 * 成 `child.kill()`:只杀直接子进程,`claude -p` / `codex` / `agy` 自己再开的 MCP 服务端
 * 与子代理留在系统里继续跑(2026-09-23 在 win-test 真机复现)。修法不在杀的那一侧,而在
 * **spawn 的那一侧**:win32 上把 `(命令, 参数)` 换成 `(cc-jobspawn, [命令, ...参数])`。
 * `cc-jobspawn`(见 `scripts/jobspawn.rs`)把自己放进一个 `KILL_ON_JOB_CLOSE` 的 job,
 * 子孙自动继承成员身份 —— 原有的 `child.kill()` 杀掉它,内核就把整棵树收掉。
 * **所以十几处 kill 一行都不用改。**
 *
 * 三条定下来的规矩:
 *
 * 1. **只在 win32 包。** 其他平台原样返回 —— POSIX 上进程组本来就好使,多套一层进程
 *    只会多一层麻烦。(`cc-jobspawn` 在 POSIX 上仍然构建、行为是直通,那是为了
 *    `externalBin` 的文件必须存在,不是为了在 POSIX 上用它。)
 * 2. **找不到就降级 + 大声留痕,不抛错。** 今天的状态是「静默漏进程树」;降级之后至少
 *    变成「漏了但有人知道」。抛错会让整个功能不可用,比漏更糟。
 * 3. **诊断不许进 stdout。** ACP 与 codex app-server 靠 stdin/stdout 的 JSON-RPC;
 *    `cc-jobspawn` 自己的诊断全走 stderr,这里的留痕走 `log()`(stderr + channel.log)。
 *
 * 怎么找到 `cc-jobspawn`:
 *   ① `WECHAT_CC_JOBSPAWN` 指的绝对路径(测试与真机验证用它;**显式指定却不存在就算
 *      找不到**,不偷偷回落到别处 —— 否则验证时你以为在验 A 其实在验 B);
 *   ② 打包版:和 `process.execPath` 并排的 `cc-jobspawn.exe`(Tauri 的 `externalBin`
 *      会把 `cc-jobspawn-<triple>.exe` 装成去掉 triple 的名字,同 `wechat-cc-cli`);
 *   ③ 并排的带 triple 名字(直接跑 build-sidecar 产物目录里的二进制时)。
 * 开发态(从源码 `bun run`)没有编译产物 ⇒ 走规矩 2,用 ① 可以手动指。
 */
// win32 的路径一律用 node:path 的 win32 实现:这份解析只在 win32 上生效,但**测试
// 在 mac / linux 上跑** —— 用默认的 posix 版本会把 `C:\a\b` 当成一整个文件名,
// 于是 dirname 出来是 `.`,断言只能跟着写歪(同 find-codex-binary.ts 的理由)。
import { win32 as winPath } from 'node:path'
import { existsSync } from 'node:fs'
import { log } from './log'

/** 产物基名。build-sidecar 编成 `cc-jobspawn-<rustTriple>[.exe]`,Tauri 装成 `cc-jobspawn[.exe]`。 */
export const JOBSPAWN_BASENAME = 'cc-jobspawn'
/** 覆盖用的环境变量:直接给出 `cc-jobspawn` 可执行文件的路径。 */
export const JOBSPAWN_PATH_ENV = 'WECHAT_CC_JOBSPAWN'

/** win32 的 arch → rust target triple(和 build-sidecar.ts 的表同源)。 */
const WINDOWS_TRIPLES: Record<string, string> = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
}

export type JobspawnResolution =
  /** 非 win32:这层包装本来就不需要。 */
  | { kind: 'not-needed' }
  | { kind: 'found'; path: string; from: 'env' | 'sibling' | 'sibling-triple' }
  | { kind: 'missing'; tried: readonly string[] }

export interface ResolveJobspawnInput {
  platform: string
  /** `process.arch`;认不出来就只找不带 triple 的那个名字。 */
  arch?: string
  /** `process.execPath` —— 打包版的 sidecar 自己,`cc-jobspawn` 和它并排。 */
  execPath: string
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
}

/** 纯函数:三种情形(覆盖 / 并排 / 找不到)在测试里能各演一遍。 */
export function resolveJobspawn(input: ResolveJobspawnInput): JobspawnResolution {
  if (input.platform !== 'win32') return { kind: 'not-needed' }

  const override = input.env[JOBSPAWN_PATH_ENV]?.trim()
  if (override) {
    // 显式指定就只认它:回落会让「我验的到底是哪个二进制」变成猜。
    return input.exists(override)
      ? { kind: 'found', path: override, from: 'env' }
      : { kind: 'missing', tried: [override] }
  }

  const dir = winPath.dirname(input.execPath)
  const tried: string[] = []
  const sibling = winPath.join(dir, `${JOBSPAWN_BASENAME}.exe`)
  tried.push(sibling)
  if (input.exists(sibling)) return { kind: 'found', path: sibling, from: 'sibling' }

  const triple = input.arch ? WINDOWS_TRIPLES[input.arch] : undefined
  if (triple) {
    const withTriple = winPath.join(dir, `${JOBSPAWN_BASENAME}-${triple}.exe`)
    tried.push(withTriple)
    if (input.exists(withTriple)) return { kind: 'found', path: withTriple, from: 'sibling-triple' }
  }

  return { kind: 'missing', tried }
}

/** 降级那一行的文案。后果写在句子里 —— 看一眼就知道丢了什么,而不是只看到一个码。 */
export function jobspawnMissingLine(tried: readonly string[]): string {
  return 'cc-jobspawn 找不到(找过:' + (tried.length ? tried.join(' , ') : '(无)') + ')'
    + ' —— 进程树清理已退化,孙子进程(claude/codex/agy 自己开的 MCP 与子代理)在任务被取消或'
    + `超时之后可能残留在系统里;设 ${JOBSPAWN_PATH_ENV}=<cc-jobspawn.exe 路径> 可以指定它。`
}

/** `(命令, 参数)` → 实际要 spawn 的 `(命令, 参数)`。win32 上包一层,其他平台原样。 */
export type ProcessTreeWrapper = (command: string, args?: readonly string[]) => { command: string; args: string[] }

export interface ProcessTreeWrapperDeps {
  /** 只会被调用一次(结果记住):每次 spawn 都 stat 一遍文件系统不值当。 */
  resolve: () => JobspawnResolution
  log: (line: string) => void
}

export function createProcessTreeWrapper(deps: ProcessTreeWrapperDeps): ProcessTreeWrapper {
  let resolution: JobspawnResolution | null = null
  let announced = false
  return (command, args = []) => {
    resolution ??= deps.resolve()
    if (resolution.kind === 'found') return { command: resolution.path, args: [command, ...args] }
    if (resolution.kind === 'missing' && !announced) {
      // 每个进程只喊一次:喊一万遍等于没喊(日志里就淹了),但一次都不喊就是今天的病。
      announced = true
      deps.log(jobspawnMissingLine(resolution.tried))
    }
    return { command, args: [...args] }
  }
}

/**
 * 产线用的那一个。模块加载时就定下 env / execPath,所以 `WECHAT_CC_JOBSPAWN` 要在
 * 启动 daemon **之前**设好(真机验证按这个来)。
 */
export const wrapForProcessTree: ProcessTreeWrapper = createProcessTreeWrapper({
  resolve: () => resolveJobspawn({
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    env: process.env,
    exists: existsSync,
  }),
  log: line => log('JOBSPAWN', line),
})
