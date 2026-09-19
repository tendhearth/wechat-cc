/**
 * self-change-glue — 自改流水线(spec 2026-09-18-self-change-pipeline §daemon 侧)
 * 跟主人打交道的那一小块。
 *
 * 为什么要单独一层:自改流水线跑在 daemon **外面**(一个 CLI 进程),它自己
 * 既没有 ilink 连接也没有主人的 chatId。它只需要三件事:往主人微信里说一句、
 * 问主人一个 y/n、过一会儿回来看主人拍了没有。这三件事在 daemon 里就是
 * sendMessage / PendingPermissions / 一张缓存表,凑在一起放这儿,路由层只做
 * 校验与状态码,main.ts 只做接线。
 *
 * 那张缓存表是本文件存在的真正理由:PendingPermissions.consume() 一旦被调用,
 * 条目就从登记处消失了 —— 而自改 CLI 是**事后**才来查决定的(它可能正在跑
 * 测试、也可能刚被重启)。所以 register() 那个 promise 的结果必须由我们自己
 * 记下来,保留 retainMs(缺省 60 分钟)再清。清的口径是「落定之后开始算」:
 * 还在 pending 的永远不清,因为主人有权想很久(timeout 由登记处自己管)。
 */

/** `unknown` = 从没问过、或者问过但答案已经过了保留期。 */
export type SelfChangeDecision = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'

export interface SelfChangeDep {
  notice(text: string): Promise<{ ok: true } | { ok: false; error: 'owner_chat_unknown' | 'send_failed' }>
  ask(prompt: string, timeoutMs: number): Promise<{ ok: true; hash: string; code: string | null } | { ok: false; error: 'owner_chat_unknown' }>
  decision(hash: string): SelfChangeDecision
}

export interface SelfChangeGlueDeps {
  ownerChatId: () => string | null
  sendMessage: (chatId: string, text: string) => Promise<unknown>
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  codeOf: (hash: string) => string | null
  newHash: () => string
  now: () => number
  /** 决定落定后还能查多久,缺省 60 分钟。 */
  retainMs?: number
}

const DEFAULT_RETAIN_MS = 60 * 60 * 1000

export function makeSelfChangeGlue(deps: SelfChangeGlueDeps): SelfChangeDep {
  const retainMs = deps.retainMs ?? DEFAULT_RETAIN_MS
  /** settledAt=null 表示还在等主人 —— 永不清。 */
  const decided = new Map<string, { decision: SelfChangeDecision; settledAt: number | null }>()

  function sweep(): void {
    const now = deps.now()
    for (const [hash, e] of decided) {
      if (e.settledAt !== null && now - e.settledAt >= retainMs) decided.delete(hash)
    }
  }

  function settle(hash: string, decision: SelfChangeDecision): void {
    decided.set(hash, { decision, settledAt: deps.now() })
  }

  return {
    async notice(text) {
      sweep()
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'owner_chat_unknown' }
      try {
        // sendMessage 回 { msgId, error? }:外发失败时它**不抛**,只把 error 填上
        // (errcode=-2 主动推送窗口关着就是这样)。两种都得当成没送到,否则自改
        // 流水线会以为主人已经知道了,一路往下跑。
        const r = (await deps.sendMessage(owner, text)) as { error?: unknown } | null | undefined
        if (r && typeof r === 'object' && 'error' in r && r.error) return { ok: false, error: 'send_failed' }
      } catch {
        return { ok: false, error: 'send_failed' }
      }
      return { ok: true }
    },

    async ask(prompt, timeoutMs) {
      sweep()
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'owner_chat_unknown' }
      const hash = deps.newHash()
      decided.set(hash, { decision: 'pending', settledAt: null })
      // 不 await:这个 promise 要等主人回微信(可能几十分钟)。askUser 内部第一句
      // 就是同步的 pending.register(hash, ...)(ilink-glue.ts:417),所以下面
      // codeOf(hash) 拿得到那两位数码 —— 主人在手机上回「y 07」靠的就是它。
      void deps.askUser(owner, prompt, hash, timeoutMs).then(
        (d) => settle(hash, d),
        // askUser 自己炸了(adapter 没了之类):记成 undelivered,别让调用方
        // 永远 pending 地等下去。
        () => settle(hash, 'undelivered'),
      )
      return { ok: true, hash, code: deps.codeOf(hash) }
    },

    decision(hash) {
      sweep()
      return decided.get(hash)?.decision ?? 'unknown'
    },
  }
}
