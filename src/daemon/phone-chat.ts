/**
 * phone-chat.ts — 手机「跟 CC 说」(spec 2026-10-01 §1.1、§3):收下即回,companionConverse 在后台跑,
 * 回复经 matter/<聊天> 主题唤醒手机去拉。隧道约 15 秒没流量就断,所以不能同步等回复。
 * 表只在内存:daemon 重启就忘(手机按「可能没送到」处理,见 apps/app/src/view/chat.ts)。
 *
 * `converse` 由接线方给,必须走既有的回合串行入口(和微信 / 桌面「跟 CC 说」同一条),
 * 这里不管串行,只管:一次一句、按 requestId 去重、失败不自动重发(重试 = 同一 requestId 再发)。
 */
export type ChatJobStatus = 'pending' | 'replied' | 'failed'
export type ChatJobError = 'busy' | 'unavailable' | 'not_configured'
export interface ChatJob { requestId: string; matterId: string; text: string; status: ChatJobStatus; since: number; error?: ChatJobError }
export interface PhoneChat {
  /** 收下即回。抛 'no_owner_chat' | 'chat_busy'。 */
  say(requestId: string, text: string): ChatJob
  state(): { pending: ChatJob | null; failed: ChatJob | null }
  /** 正在等回复的那件事的 matterId(给主题来源)。 */
  pendingMatter(): string | null
}
export const PHONE_CHAT_JOB_TTL_MS = 3_600_000
/** converse 挂住超过这么久就判失败,免得一个卡死的回合让手机永远 chat_busy。 */
export const PHONE_CHAT_TIMEOUT_MS = 600_000
const MAX_JOBS = 50

const errorOf = (e: unknown): ChatJobError => {
  const m = e instanceof Error ? e.message : ''
  if (m === 'reply_sink_busy' || m === 'owner_chat_in_chatroom_mode') return 'busy'
  if (m === 'companion_owner_chat_not_configured') return 'not_configured'
  return 'unavailable'
}

export function makePhoneChat(d: {
  converse(text: string): Promise<{ reply: string }>
  ownerMatterId(): string | null
  onSettled?(matterId: string): void
  now?: () => number
  log?: (tag: string, line: string) => void
}): PhoneChat {
  const now = d.now ?? (() => Date.now())
  const jobs = new Map<string, ChatJob>()
  let pending: ChatJob | null = null
  let failed: ChatJob | null = null
  /** 结束时刻(只内部用,不进回包):过期按它算,不按收下时刻。 */
  const settledAt = new WeakMap<ChatJob, number>()
  const ageFrom = (j: ChatJob) => settledAt.get(j) ?? j.since
  const sweep = () => {
    const cutoff = now() - PHONE_CHAT_JOB_TTL_MS
    for (const [k, j] of jobs) if (j.status !== 'pending' && (ageFrom(j) < cutoff || jobs.size > MAX_JOBS)) jobs.delete(k)
  }
  const wake = (job: ChatJob) => {
    try { d.onSettled?.(job.matterId) } catch { /* 唤醒失败不影响结果 */ }
  }
  const log = (line: string) => {
    try { d.log?.('PHONE_CHAT', line) } catch { /* 日志坏了不影响结果 */ }
  }
  const run = (job: ChatJob) => {
    pending = job; failed = null
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (e: unknown | null) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      settledAt.set(job, now())
      if (e === null) job.status = 'replied'
      else { job.status = 'failed'; job.error = errorOf(e); failed = job }
      // 先放开 pending 再做任何可能抛的事:主人对话不能被卡成永远 busy。
      if (pending === job) pending = null
      wake(job)
      if (e !== null) log(`say ${job.requestId.slice(0, 8)} failed: ${job.error}`)
    }
    timer = setTimeout(() => finish(new Error('phone_chat_timeout')), PHONE_CHAT_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    // Promise.resolve().then:converse 同步抛错也落成 failed,不会让 pending 卡死。
    Promise.resolve().then(() => d.converse(job.text)).then(
      () => {
        if (!done) return finish(null)
        // 超时后才回来的回复:状态仍是 failed(不翻案),但回复已落进对话,再唤醒一次手机去拉,
        // 免得主人以为没回、点重试起第二轮。promise 只会 resolve 一次,所以至多多发这一次。
        log(`say ${job.requestId.slice(0, 8)} late reply`)
        wake(job)
      },
      e => finish(e),
    )
  }
  const visibleFailed = () => (failed && ageFrom(failed) >= now() - PHONE_CHAT_JOB_TTL_MS ? failed : null)
  return {
    say(requestId, text) {
      const seen = jobs.get(requestId)
      if (seen && seen.status !== 'failed') return { ...seen }
      if (pending && pending.requestId !== requestId) throw new Error('chat_busy')
      const matterId = d.ownerMatterId()
      if (!matterId) throw new Error('no_owner_chat')
      const job: ChatJob = { requestId, matterId, text, status: 'pending', since: now() }
      // 先删再放:重试的那条挪到队尾,不会因为第一次收下得早而被当成最旧的挤掉。
      jobs.delete(requestId); jobs.set(requestId, job); sweep()
      run(job)
      return { ...job }
    },
    state: () => {
      const f = visibleFailed()
      return { pending: pending ? { ...pending } : null, failed: f ? { ...f } : null }
    },
    pendingMatter: () => pending?.matterId ?? null,
  }
}
