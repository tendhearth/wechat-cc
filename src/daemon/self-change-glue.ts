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
 *
 * **为什么 ask 不走 ilink 的 askUser**(2026-09-18 真机):askUser 在外发失败时
 * 会 `pending.fail(hash)` 把条目从登记处删掉 —— 对一轮工具调用是对的(没人
 * 能回,别让整轮死等),但自改的拍板还有**两条**路:桌面权限卡
 * (`POST /v1/permissions/resolve`)和终端 `wechat-cc self change --approve <id>`。
 * 那天微信外发整个不通(`ilink/sendmessage errcode=-2: prepare failed`),
 * 实现/测试/评审/CI 全绿的一条自改就这么白跑到 approval_timeout,桌面卡也
 * 早被删了没得拍。所以这里改成:自己登记、自己发卡,**发不出去也不动条目**,
 * 只把 `delivered: false` 如实报给 CLI,让它告诉人换个面拍。
 */
import { howToReplyLine, type PendingPermissionMeta, type PermissionDecision } from './pending-permissions'

/** `unknown` = 从没问过、或者问过但答案已经过了保留期。 */
export type SelfChangeDecision = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'

export interface SelfChangeDep {
  notice(text: string): Promise<{ ok: true } | { ok: false; error: 'owner_chat_unknown' | 'send_failed' }>
  /**
   * `delivered=false` 表示卡片没进微信 —— 但条目**还在**登记处,桌面 / 终端
   * 照样能拍板。调用方别把它当失败。
   */
  ask(prompt: string, timeoutMs: number): Promise<{ ok: true; hash: string; code: string | null; delivered: boolean } | { ok: false; error: 'owner_chat_unknown' }>
  decision(hash: string): SelfChangeDecision
}

export interface SelfChangeGlueDeps {
  ownerChatId: () => string | null
  sendMessage: (chatId: string, text: string) => Promise<unknown>
  /** 只登记、不发卡(= ilink.registerPendingPermission = pending.register)。 */
  registerPending: (hash: string, timeoutMs: number, meta: PendingPermissionMeta) => Promise<PermissionDecision>
  /** 到点扫一遍待批(= ilink.sweepPendingPermissions);照 askUser 的做法在 timeoutMs+1 排一次。 */
  sweepPending: () => void
  codeOf: (hash: string) => string | null
  newHash: () => string
  now: () => number
  /** 决定落定后还能查多久,缺省 60 分钟。 */
  retainMs?: number
  /** 外发失败时记一句(缺省不记)。绝不打 token / 卡片正文。 */
  log?: (line: string) => void
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
      // 不 await:这个 promise 要等主人拍板(可能几十分钟)。register 是同步落表的,
      // 所以下面 codeOf(hash) 拿得到那两位数码 —— 主人在手机上回「y 07」靠的就是它。
      void deps.registerPending(hash, timeoutMs, { chatId: owner, prompt }).then(
        (d) => settle(hash, d),
        // 登记处自己炸了(adapter 没了之类):记成 undelivered,别让调用方
        // 永远 pending 地等下去。
        () => settle(hash, 'undelivered'),
      )
      const code = deps.codeOf(hash)
      // 到点扫一遍,好让 promise 以 'timeout' 落定 —— 全局 30 秒那个 sweep 不一定
      // 正好踩在边界上。unref:这条排程不该吊着进程(假时钟测试也能推过去)。
      const t = setTimeout(() => { deps.sweepPending() }, timeoutMs + 1)
      if (typeof t.unref === 'function') t.unref()

      // 发卡。措辞与工具权限卡共用 howToReplyLine —— 主人认的就是这一行。
      const card = `${prompt}\n${howToReplyLine(code, hash, timeoutMs)}`
      let delivered = true
      try {
        const r = (await deps.sendMessage(owner, card)) as { error?: unknown } | null | undefined
        if (r && typeof r === 'object' && 'error' in r && r.error) {
          delivered = false
          deps.log?.(`self-change 拍板卡没送到 ${owner}:${String(r.error)} —— 条目留在登记处,桌面 / 终端仍可拍板`)
        }
      } catch (err) {
        delivered = false
        deps.log?.(`self-change 拍板卡外发抛了 ${owner}:${err instanceof Error ? err.message : String(err)} —— 条目留在登记处,桌面 / 终端仍可拍板`)
      }
      // 注意:这里**不** fail(hash)。卡片没送到 ≠ 没人能拍板。
      return { ok: true, hash, code, delivered }
    },

    decision(hash) {
      sweep()
      return decided.get(hash)?.decision ?? 'unknown'
    },
  }
}
