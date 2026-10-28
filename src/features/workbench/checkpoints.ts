/**
 * 每轮边界一个 checkpoint(回退设计稿切片 1,2026-10-21):把**整个**工作区(wt.root,不是 task.path)此刻的样子
 * 打成一个真的 commit 对象,挂在 `refs/tendhearth/checkpoints/<taskId>/<commit12>` 上(有 ref 才不被 gc)。
 *   - 临时 index 在仓库外(`<stateDir>/tmp/cp-*.index`),先拷真 index 借 stat 缓存,拷不了 / 用不了就 `read-tree HEAD`;
 *     主人的真 index、HEAD、分支一个字节不动。
 *   - `add -A` 不收 .cc-workbench / .cc-workbench-inputs;ignored 文件本来就不进。
 *   - 不跑钩子、不跑过滤器(LFS clean 之类)、不签名、不读系统 / 全局配置;身份写死。
 *     唯一例外:全局配置里的 core.excludesFile(缺省 ~/.config/git/ignore)单独读出来再 `-c` 传回 ——
 *     主人全局忽略的 .env / *.pem / node_modules 不能被扫进 ref(评审 #428)。
 *   - 整个 checkpoint 一个总期限(CHECKPOINT_DEADLINE_MS):到点杀掉在跑的 git、回 `timeout`;调用方的 signal ⇒ `aborted`。
 *   - 体积超限(未跟踪 + 修改合计 / 单文件 / 路径数)⇒ 跳过,那一轮不可回退。
 *   - 仓库用 LFS / 任何 required 过滤器 / 任何 `filter=` 属性 ⇒ 整个不打(`filter_repo`):过滤器中和后,
 *     stat 过期的 LFS 文件会以原始字节入树、没动的仍是指针,回退时会把指针文本写回去(设计评审 10-21)。
 *   - 删工作区(归档时自动删干净的工作区)**不清** ref —— 那是仅有的备份。保留策略(切片 2):每件事至多
 *     CHECKPOINT_KEEP 个(pruneCheckpoints,旧的随裁);cc/<id> 分支没了或归档满 30 天 ⇒ deleteCheckpointRefs(service/rewind.ts)。
 * 只给独立工作区用(调用方挡);任何 git 失败都回 `{skipped}`,从不抛 —— checkpoint 失败绝不能拖垮一轮。
 * 全程异步子进程,不卡事件循环。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { filterOverrides, gitEnv } from './git-review'

const execute = promisify(execFile)
export const CHECKPOINT_LIMITS = { maxTotalBytes: 200 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024, maxPaths: 20_000 }
export type CheckpointLimits = typeof CHECKPOINT_LIMITS
export type CheckpointSkip = 'filter_repo' | 'not_git' | 'git_error' | 'timeout' | 'aborted' | 'invalid_task' | 'too_many_paths' | 'file_too_large' | 'too_large'
/** sameTree = 树和 prev 的一样(这一段里工作区没变;HEAD 动过时 commit 仍是新的)。 */
export type CheckpointResult = { commit: string; tree: string; sameTree: boolean } | { skipped: CheckpointSkip }
export const CHECKPOINT_REF_PREFIX = 'refs/tendhearth/checkpoints/'
export const REWIND_REF_PREFIX = 'refs/tendhearth/rewind/'

// hooksPath 指向空设备:git 在那下面找不到任何钩子(Windows 同 self-change/git.ts 用 NUL)
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
export const SAFE = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`, '-c', 'core.autocrlf=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
export const EXCLUDE = [':(exclude,glob)**/.cc-workbench/**', ':(exclude,glob)**/.cc-workbench-inputs/**']
const IDENTITY = ['-c', 'user.name=Tendhearth CC', '-c', 'user.email=cc@localhost', '-c', 'commit.gpgSign=false']
const TASK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const TIMEOUT_MS = 60_000
/** 一次 checkpoint 的总期限(和差异基线的 15 秒同档):回合起点 / 续接 / 轮末收尾都在等它。 */
export const CHECKPOINT_DEADLINE_MS = 15_000

class Cancelled extends Error {}
type Run = (args: string[], opts?: { index?: string; maxBuffer?: number; input?: string }) => Promise<Buffer>
/** 跑一条 git 的底层(测试注入慢 git 用);必须认 signal:abort ⇒ 杀进程、reject。 */
export type GitExec = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; signal?: AbortSignal }) => Promise<Buffer>
const realExec: GitExec = async (args, opts) => {
  const { stdout } = await execute('git', args, { cwd: opts.cwd, env: opts.env, encoding: 'buffer', maxBuffer: opts.maxBuffer, timeout: TIMEOUT_MS, windowsHide: true, ...(opts.signal ? { signal: opts.signal } : {}) })
  return Buffer.from(stdout)
}

function runner(cwd: string, signal?: AbortSignal, exec: GitExec = realExec): { run: Run; filters: string[] } {
  const filters: string[] = []
  const base = gitEnv()
  const run: Run = async (args, opts = {}) => {
    if (signal?.aborted) throw new Cancelled()
    const env = opts.index ? { ...base, GIT_INDEX_FILE: opts.index } : base
    try {
      if (opts.input !== undefined) return await withInput([...SAFE, ...filters, ...args], cwd, env, opts.input, signal)
      return await exec([...SAFE, ...filters, ...args], { cwd, env, maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, ...(signal ? { signal } : {}) })
    } catch (error) { if (signal?.aborted) throw new Cancelled(); throw error }
  }
  return { run, filters }
}
const notSet = (error: unknown) => { if (error instanceof Cancelled || (error as { code?: number }).code !== 1) throw error }
/**
 * 主人全局配置里的 core.excludesFile(gitEnv 不读全局配置,只把这一项捞回来)。仓库自己配了 ⇒ git 会读它,不插手。
 * 顺序同 git:$XDG_CONFIG_HOME/git/config,再 ~/.gitconfig(后者优先);都没配 ⇒ git 的缺省 $XDG_CONFIG_HOME/git/ignore。
 */
async function globalExcludes(run: Run): Promise<string[]> {
  try { if (line(await run(['config', '--get', 'core.excludesFile']))) return [] } catch (error) { notSet(error) }
  const home = process.env.HOME || homedir()
  if (!home) return []
  const xdg = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'git') : join(home, '.config', 'git')
  let path = ''
  for (const file of [join(xdg, 'config'), join(home, '.gitconfig')]) {
    try { await stat(file) } catch { continue }
    try { path = line(await run(['config', '--file', file, '--includes', '--path', '--get', 'core.excludesFile'])) || path } catch (error) { notSet(error) }
  }
  return ['-c', `core.excludesFile=${path || join(xdg, 'ignore')}`]
}
function withInput(args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = execFile('git', args, { cwd, env, encoding: 'buffer', timeout: TIMEOUT_MS, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout) => error ? fail(error) : done(Buffer.from(stdout)))
    child.stdin?.on('error', () => { /* 子进程先退了;错误走回调 */ })
    child.stdin?.end(input)
  })
}
const line = (bytes: Buffer) => bytes.toString('utf8').trim()
const entries = (bytes: Buffer) => { const out: Buffer[] = []; let at = 0; for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { if (i > at) out.push(bytes.subarray(at, i)); at = i + 1 } if (at < bytes.length) out.push(bytes.subarray(at)); return out }

const ATTR_FILTER = /^[^#\n]*\sfilter=/m
/** 仓库有没有在用过滤器:配置里有 LFS 或 required=true,或任何一份 attributes 里写了 filter=。读不了就当有(宁可不打)。 */
async function usesFilters(run: Run, top: string): Promise<boolean> {
  let config = ''
  try { config = (await run(['config', '--null', '--get-regexp', '^filter\\.'])).toString('utf8') }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error }
  for (const item of config.split('\0').filter(Boolean)) {
    const [key = '', value = ''] = item.split('\n')
    if (/^filter\.lfs\./i.test(key) || (/\.required$/i.test(key) && /^(true|yes|on|1)$/i.test(value.trim()))) return true
  }
  const files = entries(await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.gitattributes', ...EXCLUDE])).map(rel => join(top, rel.toString('utf8')))
  files.push(resolve(top, line(await run(['rev-parse', '--git-path', 'info/attributes']))))
  let attributesFile = ''
  try { attributesFile = line(await run(['config', '--path', '--get', 'core.attributesFile'])) } catch (error) { if ((error as { code?: number }).code !== 1) throw error }
  if (attributesFile) files.push(resolve(top, attributesFile))
  for (const path of files) {
    let text: string
    try { text = await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return true }
    // 行首也算:前面补一个空白再查
    if (ATTR_FILTER.test(text.replace(/^/gm, ' '))) return true
  }
  return false
}

/** add 之前按 status 估一下要哈希多少:超限就别让 git 去啃(也不往对象库里塞几百兆)。 */
async function oversize(run: Run, top: string, limits: CheckpointLimits): Promise<CheckpointSkip | null> {
  let out: Buffer
  try { out = await run(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', '.', ...EXCLUDE], { maxBuffer: 64 * 1024 * 1024 }) }
  catch (error) { if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too_many_paths'; throw error }
  const list = entries(out)
  if (list.length > limits.maxPaths) return 'too_many_paths'
  const prefix = Buffer.from(top.endsWith(sep) ? top : top + sep)
  let total = 0
  // 分批异步 lstat:两万个路径也不卡事件循环
  for (let i = 0; i < list.length; i += 128) {
    const sizes = await Promise.all(list.slice(i, i + 128).map(async entry => {
      if (entry.length < 4 || entry.subarray(0, 2).includes(0x44 /* D */)) return 0
      try { const stat = await lstat(Buffer.concat([prefix, entry.subarray(3)])); return stat.isFile() ? stat.size : 0 } catch { return 0 }
    }))
    for (const size of sizes) {
      if (size > limits.maxFileBytes) return 'file_too_large'
      total += size
      if (total > limits.maxTotalBytes) return 'too_large'
    }
  }
  return null
}

export interface CheckpointInput { root: string; taskId: string; stateDir: string; prev?: string; signal?: AbortSignal; limits?: Partial<CheckpointLimits>; deadlineMs?: number; exec?: GitExec }
export async function takeCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
  if (!TASK.test(input.taskId)) return { skipped: 'invalid_task' }
  if (input.signal?.aborted) return { skipped: 'aborted' }
  const control = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; control.abort() }, input.deadlineMs ?? CHECKPOINT_DEADLINE_MS)
  const onAbort = () => control.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await checkpoint(input, control.signal)
    // 到点和调用方叫停走同一条 abort;没成的那一份才按原因改判(碰巧已经成了就是成了)
    return 'skipped' in result && result.skipped === 'aborted' && timedOut ? { skipped: 'timeout' } : result
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort) }
}
async function checkpoint(input: CheckpointInput, signal: AbortSignal): Promise<CheckpointResult> {
  const limits = { ...CHECKPOINT_LIMITS, ...input.limits }
  let index: string | undefined
  try {
    let top: string, realIndex: string
    try {
      // --git-path index:独立工作区(linked worktree)拿到的是它自己的 .git/worktrees/<名>/index
      const [a, b] = (await runner(input.root, signal, input.exec).run(['rev-parse', '--show-toplevel', '--git-path', 'index'])).toString('utf8').split('\n')
      if (!a || !b) return { skipped: 'git_error' }
      top = a; realIndex = resolve(input.root, b)
    } catch (error) {
      if (error instanceof Cancelled) return { skipped: 'aborted' }
      return { skipped: String((error as { stderr?: Buffer }).stderr ?? '').includes('not a git repository') ? 'not_git' : 'git_error' }
    }
    const { run, filters } = runner(top, signal, input.exec)
    // 先挂全局忽略:被忽略目录里的 .gitattributes 不该把仓库判成 filter_repo,status / add 也照它
    filters.push(...await globalExcludes(run))
    if (await usesFilters(run, top)) return { skipped: 'filter_repo' }
    filters.push(...await filterOverrides(args => run(args)))
    let head: string | null = null
    try { head = line(await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])) || null } catch (error) { if (error instanceof Cancelled) throw error /* 未出生的分支:没有父 */ }
    const tooBig = await oversize(run, top, limits)
    if (tooBig) return { skipped: tooBig }
    const tmp = join(input.stateDir, 'tmp')
    await mkdir(tmp, { recursive: true, mode: 0o700 })
    index = join(tmp, `cp-${randomBytes(8).toString('hex')}.index`)
    const seedFresh = async () => { await rm(index!, { force: true }); if (head) await run(['read-tree', head], { index }) }
    const add = () => run(['add', '-A', '--', '.', ...EXCLUDE], { index })
    let copied = false
    try {
      // git 拿 index 文件自己的 mtime 判「racily clean」:拷贝的 mtime 是现在 ⇒ 刚改过、大小没变的文件会被当成没动。
      // 把拷贝的 mtime 往回拨到原件之前 1 秒:只会让更多条目被重新哈希,不会漏(node 下真机抓到)。
      const original = await stat(realIndex)
      await copyFile(realIndex, index)
      const back = new Date(original.mtimeMs - 1000)
      await utimes(index, back, back)
      copied = true
    } catch { await seedFresh() }
    try { await add() } catch (error) {
      // 拷来的 index 用不了(split-index、版本怪)⇒ 从 HEAD 重来一次
      if (!copied || error instanceof Cancelled) throw error
      await seedFresh(); await add()
    }
    const tree = line(await run(['write-tree'], { index }))
    if (!OID.test(tree)) return { skipped: 'git_error' }
    let sameTree = false
    if (input.prev && OID.test(input.prev)) {
      try {
        const body = (await run(['cat-file', 'commit', input.prev])).toString('utf8')
        const header = body.slice(0, body.indexOf('\n\n'))
        const prevTree = /^tree ([0-9a-f]+)$/m.exec(header)?.[1]
        const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map(m => m[1])
        sameTree = prevTree === tree
        // 树一样、父也一样 ⇒ 就是同一个点,复用
        if (sameTree && parents.length === (head ? 1 : 0) && (!head || parents[0] === head)) {
          await run(['update-ref', `${CHECKPOINT_REF_PREFIX}${input.taskId}/${input.prev.slice(0, 12)}`, input.prev])
          return { commit: input.prev, tree, sameTree: true }
        }
      } catch (error) { if (error instanceof Cancelled) throw error /* prev 不在了:照常新打一个 */ }
    }
    const commit = line(await run([...IDENTITY, 'commit-tree', tree, ...(head ? ['-p', head] : []), '--no-gpg-sign', '-m', `cc checkpoint ${input.taskId}`]))
    if (!OID.test(commit)) return { skipped: 'git_error' }
    await run(['update-ref', `${CHECKPOINT_REF_PREFIX}${input.taskId}/${commit.slice(0, 12)}`, commit])
    return { commit, tree, sameTree }
  } catch (error) {
    return { skipped: error instanceof Cancelled || signal.aborted ? 'aborted' : 'git_error' }
  } finally {
    if (index) await Promise.all([rm(index, { force: true }), rm(`${index}.lock`, { force: true })]).catch(() => {})
  }
}

/** 清掉这件事的 checkpoint 与回退备份 ref(保留期满 / 分支没了,service/rewind.ts;尽力而为,不抛)。root 是仓库里任一目录(ref 在公共目录)。 */
export async function deleteCheckpointRefs(root: string, taskId: string): Promise<number> {
  if (!TASK.test(taskId)) return 0
  try {
    const { run } = runner(root)
    const refs = (await run(['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}${taskId}/`, `${REWIND_REF_PREFIX}${taskId}/`])).toString('utf8').split('\n').filter(Boolean)
    if (!refs.length) return 0
    await run(['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}\n`).join('') })
    return refs.length
  } catch { return 0 }
}

/** 每件事至多留这么多个 checkpoint(更老的随裁;回退备份 refs/tendhearth/rewind/ 不算在内)。 */
export const CHECKPOINT_KEEP = 50
/** 只留最近 keep 个 checkpoint ref(按提交时间,新的在后),多的删掉。尽力而为,不抛;回删了几个。 */
export async function pruneCheckpoints(root: string, taskId: string, keep = CHECKPOINT_KEEP): Promise<number> {
  if (!TASK.test(taskId)) return 0
  try {
    const { run } = runner(root)
    const refs = (await run(['for-each-ref', '--sort=committerdate', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}${taskId}/`])).toString('utf8').split('\n').filter(Boolean)
    const drop = refs.slice(0, Math.max(0, refs.length - keep))
    if (!drop.length) return 0
    await run(['update-ref', '--stdin'], { input: drop.map(ref => `delete ${ref}\n`).join('') })
    return drop.length
  } catch { return 0 }
}

/**
 * 回退的同步段要用的 git 参数(全局忽略 + 过滤器中和),和 checkpoint 打树时完全一致 —— 两边算出的树才对得上。
 * 过滤器仓库 ⇒ `{skipped:'filter_repo'}`(不可回退)。
 */
export async function checkpointGitArgs(root: string): Promise<{ top: string; filters: string[] } | { skipped: CheckpointSkip }> {
  try {
    const top = line(await runner(root).run(['rev-parse', '--show-toplevel']))
    if (!top) return { skipped: 'git_error' }
    const { run, filters } = runner(top)
    filters.push(...await globalExcludes(run))
    if (await usesFilters(run, top)) return { skipped: 'filter_repo' }
    filters.push(...await filterOverrides(args => run(args)))
    return { top, filters }
  } catch (error) {
    return { skipped: String((error as { stderr?: Buffer }).stderr ?? '').includes('not a git repository') ? 'not_git' : 'git_error' }
  }
}

/** doctor 用:这个仓库里 refs/tendhearth/* 有几个、最老的是哪天(提交时间,毫秒)。读不了 ⇒ null。 */
export async function listTendhearthRefs(root: string): Promise<{ count: number; oldest: number | null } | null> {
  try {
    const rows = (await runner(root).run(['for-each-ref', '--format=%(committerdate:unix)', 'refs/tendhearth/'])).toString('utf8').split('\n').filter(Boolean)
    const times = rows.map(Number).filter(n => Number.isFinite(n) && n > 0)
    return { count: rows.length, oldest: times.length ? Math.min(...times) * 1000 : null }
  } catch { return null }
}
/** doctor 的「一键清」:删掉这个仓库里所有 refs/tendhearth/*。回删了几个;出错 ⇒ 0。 */
export async function clearTendhearthRefs(root: string): Promise<number> {
  try {
    const { run } = runner(root)
    const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/tendhearth/'])).toString('utf8').split('\n').filter(Boolean)
    if (!refs.length) return 0
    await run(['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}\n`).join('') })
    return refs.length
  } catch { return 0 }
}

/** 这个本地分支还在不在;读不了仓库 ⇒ null(别据此清 ref)。 */
export async function branchExists(root: string, branch: string): Promise<boolean | null> {
  try { await runner(root).run(['rev-parse', '--git-dir']) } catch { return null }
  try { await runner(root).run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]); return true }
  catch (error) { return (error as { code?: number }).code === 1 ? false : null }
}
