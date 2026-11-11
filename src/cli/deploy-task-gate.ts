/** 部署前等交办任务停到回合边界；不靠读生产库判断，也不替主人取消任务。 */
import { createInterface } from 'node:readline/promises'
import { readApiInfo, type ApiInfo } from '../lib/api-info'

export interface DeployTask { id: string; title: string; status: string; phase: string }
export interface DeployTaskOptions { waitTasks?: boolean; force?: boolean; timeoutMs?: number; nonInteractive?: boolean }
export const DEPLOY_TASK_WAIT_MS = 20 * 60_000
export interface DeployTaskGateDeps {
  tasks(): Promise<DeployTask[] | null>
  interactive: boolean
  choose?(message: string): Promise<'wait' | 'force' | 'abort'>
  now(): number
  sleep(ms: number): Promise<void>
  log(line: string): void
}
const busy = (task: DeployTask) => ['queued', 'running', 'cancelling'].includes(task.status) && task.phase !== 'replied'

/** null = 可以部署；字符串 = 拒绝原因。非交互等待有界，交互到顶重新问，空输入继续等待。 */
export async function waitForDeployTasks(deps: DeployTaskGateDeps, opts: DeployTaskOptions = {}): Promise<string | null> {
  if (opts.force && opts.waitTasks) return '--wait-tasks 和 --force 只能选一个。'
  const timeout = opts.timeoutMs ?? DEPLOY_TASK_WAIT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) return '任务等待期限必须大于 0。'
  let deadline: number | null = null
  let listed = ''
  for (;;) {
    const all = await deps.tasks().catch(() => null)
    if (all === null) {
      if (opts.force) { deps.log('读不到交办任务状态，按 --force 继续。'); return null }
      return '读不到交办任务状态，未部署。恢复 daemon 连接后重试；确需继续可用 --force。'
    }
    const tasks = all.filter(busy)
    if (!tasks.length) return null
    const signature = JSON.stringify(tasks)
    if (signature !== listed) {
      deps.log(`有 ${tasks.length} 件交办任务在跑：\n${tasks.map(t => `  ${t.id} · ${t.title.replace(/[\r\n]+/g, ' ')} · ${t.phase}`).join('\n')}`)
      listed = signature
    }
    if (opts.force) { deps.log('按 --force 继续；重启打断的任务会尝试续接一次。'); return null }
    const expired = deadline !== null && deps.now() >= deadline
    if (deadline === null || expired) {
      if (deps.interactive && deps.choose) {
        const choice = await deps.choose(`${expired ? '已等到本轮上限。' : ''}有 ${tasks.length} 件在跑，等它们到可中断点 / 强制继续？[等待/force/取消，默认等待] `)
        if (choice === 'force') return null
        if (choice === 'abort') return '已取消部署，交办任务继续运行。'
      } else if (!opts.waitTasks) return `有 ${tasks.length} 件在跑；非交互部署请明确选择 --wait-tasks 或 --force。`
      else if (expired) return `等待交办任务超时（${Math.round(timeout / 60_000)} 分钟），未部署；任务继续运行。`
      deadline = deps.now() + timeout
      deps.log('等待交办任务到可中断点…')
    }
    await deps.sleep(Math.min(2_000, Math.max(1, deadline! - deps.now())))
  }
}

/** 每轮取完整分页；任何坏页/重复游标都拒绝，不能把未知当成没有任务。 */
export async function readDeployTasks(deps: { readInfo(): ApiInfo | null; fetch: (input: string, init: RequestInit) => Promise<Response> }): Promise<DeployTask[] | null> {
  const info = deps.readInfo()
  if (!info) return null
  const tasks = new Map<string, DeployTask>(), seen = new Set<string>()
  let cursor: string | null = null
  try {
    do {
      const res = await deps.fetch(`${info.baseUrl}/v1/workbench?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { authorization: `Bearer ${info.operatorToken}` }, signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const body: unknown = await res.json()
      if (!body || typeof body !== 'object') return null
      const b = body as { tasks?: unknown; page?: { hasMore?: unknown; nextCursor?: unknown } }
      if (!Array.isArray(b.tasks) || !b.page || typeof b.page.hasMore !== 'boolean') return null
      for (const value of b.tasks) {
        if (!value || typeof value !== 'object') return null
        const t = value as DeployTask
        if (typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.status !== 'string' || typeof t.phase !== 'string') return null
        tasks.set(t.id, t)
      }
      if (!b.page.hasMore) return [...tasks.values()]
      if (typeof b.page.nextCursor !== 'string' || !b.page.nextCursor || seen.has(b.page.nextCursor) || seen.size >= 10_000) return null
      cursor = b.page.nextCursor
      seen.add(cursor)
    } while (true)
  } catch { return null }
}

export function defaultDeployTaskGate(stateDir: string, opts: DeployTaskOptions = {}): Promise<string | null> {
  return waitForDeployTasks({
    tasks: () => readDeployTasks({ readInfo: () => readApiInfo(stateDir), fetch }),
    interactive: !opts.nonInteractive && !!process.stdin.isTTY && !!process.stderr.isTTY,
    async choose(message) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = (await rl.question(message)).trim().toLowerCase()
        return answer === 'force' || answer === '强制继续' ? 'force' : answer === '取消' || answer === 'q' ? 'abort' : 'wait'
      } catch { return 'abort' } finally { rl.close() }
    },
    now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), log: line => console.error(`[部署] ${line}`),
  }, opts)
}
