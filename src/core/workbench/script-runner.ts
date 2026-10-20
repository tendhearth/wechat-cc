/**
 * 跑独立工作区的一条脚本(setup / run / archive,见 worktree-scripts.ts)。只管起、收输出、停;
 * 什么时候跑、批准、端口、落库都是调用方的事。
 *
 * POSIX:`$SHELL -l -c <脚本>`(登录 shell,主人在终端里能用的 PATH / nvm / asdf 这里也能用),detached 自成进程组,
 * 停 = 整组 SIGTERM → KILL_GRACE_MS → SIGKILL(同 self-change 的 spawnCollect),脚本后台起的开发服务一起带走。
 * 信号只在主 shell 还活着时发:它一退(被收走),组号就可能被别的进程复用 —— 宁可漏掉不理 SIGTERM 的孤儿,也不打错人。
 * Windows:`%ComSpec% /d /s /c <脚本>`,套 cc-jobspawn(wrapForProcessTree),杀它内核收整棵树。
 * 输出:stdout + stderr 合并,只留最后 32KB;onOutput 至多每秒一次,退出前再推最后一次。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { wrapForProcessTree } from '../../lib/jobspawn'
import { workbenchSubprocessEnv } from './subprocess-env'
import type { ScriptKind } from './worktree-scripts'

/** SIGTERM 之后留给脚本收尾的时间,过了就硬杀(同 self-change runner)。 */
export const KILL_GRACE_MS = 5_000
export const OUTPUT_TAIL_CHARS = 32 * 1024
const OUTPUT_INTERVAL_MS = 1_000
/** 主进程退了但管道还被漏网的子孙拿着:最多再等这么久就当结束。 */
const CLOSE_AFTER_EXIT_MS = 2_000
const GROUP_WATCH_MS = 2_000

/** 给脚本的四个变量;port=null ⇒ 不设 TENDHEARTH_PORT。 */
export interface ScriptVars { port: number | null; workspacePath: string; rootPath: string; branch: string }

export interface ScriptExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** 到点被停的。 */
  timedOut: boolean
  /** 调用方 stop() 停的。 */
  stopped: boolean
  /** 起都没起来(shell 不在之类)。 */
  error: string | null
  tail: string
}

export interface RunningScript {
  /** POSIX 上的进程组号(= shell 的 pid);win32 没有进程组 ⇒ null。 */
  pgid: number | null
  stop(): Promise<void>
  done: Promise<ScriptExit>
}

/**
 * 脚本的环境:工作台子进程那套过滤(摘 daemon 凭据)+ 摘掉 GIT_*(daemon 若是在 git 钩子里起的,
 * GIT_DIR 之类会把脚本里的 git 指回别的仓库)+ 四个 TENDHEARTH_* 变量。
 */
export function scriptEnv(vars: ScriptVars, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = workbenchSubprocessEnv(base)
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  delete env.TENDHEARTH_PORT
  return {
    ...env,
    ...(vars.port !== null ? { TENDHEARTH_PORT: String(vars.port) } : {}),
    TENDHEARTH_WORKSPACE_PATH: vars.workspacePath,
    TENDHEARTH_ROOT_PATH: vars.rootPath,
    TENDHEARTH_BRANCH: vars.branch,
  }
}

function posixShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL || process.env.SHELL
  if (shell) return shell
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

export function startScript(input: {
  kind: ScriptKind
  script: string
  cwd: string
  env: ScriptVars
  onOutput?: (tail: string) => void
  onExit?: (exit: ScriptExit) => void
  timeoutMs?: number
  /** 测试用:基底环境(缺省 process.env)、shell、输出节流间隔。 */
  baseEnv?: NodeJS.ProcessEnv
  shell?: string
  outputIntervalMs?: number
}): RunningScript {
  const env = scriptEnv(input.env, input.baseEnv)
  const win = process.platform === 'win32'
  const [cmd, args] = win
    ? [env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', input.script]]
    : [input.shell ?? posixShell(env), ['-l', '-c', input.script]]
  const wrapped = wrapForProcessTree(cmd, args)

  let tail = ''
  let stopped = false, timedOut = false, finished = false
  let lastEmit = 0
  let emitTimer: ReturnType<typeof setTimeout> | null = null
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  /** 盯孤儿的定时器:主 shell 退了、组里还有进程时每 2 秒看一眼,组空了就停。 */
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let groupGone = false
  /** 起成功、pgid 定下来之后才为真;起都没起来就 finish 的那条路不碰进程组。 */
  let spawned = false
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const interval = input.outputIntervalMs ?? OUTPUT_INTERVAL_MS

  const emit = () => {
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null }
    lastEmit = Date.now()
    try { input.onOutput?.(tail) } catch { /* 回调出错不影响脚本 */ }
  }
  const append = (chunk: string) => {
    tail += chunk
    if (tail.length > OUTPUT_TAIL_CHARS) {
      tail = tail.slice(tail.length - OUTPUT_TAIL_CHARS)
      // 别从代理对中间切开
      const first = tail.charCodeAt(0)
      if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
    }
    if (!input.onOutput || emitTimer) return
    const wait = lastEmit + interval - Date.now()
    if (wait <= 0) emit()
    else emitTimer = setTimeout(emit, wait)
  }

  let resolveDone!: (exit: ScriptExit) => void
  const done = new Promise<ScriptExit>(resolve => { resolveDone = resolve })
  const finish = (error: string | null) => {
    if (finished) return
    finished = true
    // hardTimer 不清:主 shell 退了,组里不理 SIGTERM 的后台进程(`… &` 起的开发服务)照样要收掉,不然端口一直被占
    for (const timer of [emitTimer, timeoutTimer, closeTimer]) if (timer) clearTimeout(timer)
    emitTimer = null
    // 组空了就记死(groupGone),以后这个号码可能被主人别的进程组拿走;还有孤儿 ⇒ 盯到它们退为止(#410 评审)
    if (!spawned || !pgid) { /* 没有进程组可盯 */ }
    else if (!groupExists()) groupGone = true
    else if (!watchTimer) {
      watchTimer = setInterval(() => { if (!groupExists()) { groupGone = true; if (watchTimer) clearInterval(watchTimer); watchTimer = null } }, GROUP_WATCH_MS)
      watchTimer.unref?.()
    }
    if (input.onOutput && tail) emit()
    const exit: ScriptExit = { code: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, timedOut, stopped, error, tail }
    try { input.onExit?.(exit) } catch { /* 同上 */ }
    resolveDone(exit)
  }

  let child: ReturnType<typeof nodeSpawn>
  try {
    child = nodeSpawn(wrapped.command, wrapped.args, {
      cwd: input.cwd,
      env,
      windowsHide: true,
      // 自成一个进程组,-pid 能把脚本起的后台进程一起带走
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    finish(String((error as Error).message ?? error))
    return { pgid: null, stop: async () => { await done }, done }
  }
  const pgid = !win && child.pid ? child.pid : null
  spawned = true

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', error => finish(error.message))
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
    closeTimer = setTimeout(() => finish(null), CLOSE_AFTER_EXIT_MS)
  })
  child.on('close', (code, signal) => {
    exitInfo ??= { code, signal }
    finish(null)
  })

  // 组里只要还有一个进程活着,POSIX 就不会把这个组号分给别人 ⇒ 组没空过时 kill(-pgid, 0) 成功说明组还是我们的(#409 评审)。
  // 组一旦空过,号码就可能被别人复用 ⇒ groupGone 记死,之后一个信号都不发(#410 评审)。win32 没有进程组:只在主进程还在时 child.kill。
  const shellAlive = () => exitInfo === null && !finished
  const killGroup = (sig: NodeJS.Signals): void => {
    // 已经退干净 ⇒ ESRCH,吞掉
    try {
      if (pgid) process.kill(-pgid, sig)
      else child.kill(sig)
    } catch { /* ESRCH / 组已空 */ }
  }
  const groupExists = (): boolean => {
    if (!pgid) return shellAlive()
    if (groupGone) return false
    try { process.kill(-pgid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  const terminate = () => {
    if (!groupExists()) return
    killGroup('SIGTERM')
    if (!hardTimer) {
      hardTimer = setTimeout(() => { if (groupExists()) killGroup('SIGKILL') }, KILL_GRACE_MS)
      hardTimer.unref?.()
    }
  }
  if (input.timeoutMs !== undefined) timeoutTimer = setTimeout(() => { timedOut = true; terminate() }, input.timeoutMs)

  return {
    pgid,
    async stop() {
      if (!finished) stopped = true
      terminate()
      await done
    },
    done,
  }
}
