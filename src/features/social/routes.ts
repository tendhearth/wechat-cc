/**
 * 社交模块自己挂的路由(架构终态 A5):路由表里标了 `module: 'social'` 的那几条 —— 串门、心愿、介绍,加上笔友信箱
 * (./routes-penpal.ts)。模块关着 / 坏了 / 还没挂上,路由层的模块门回 module_off / module_degraded / module_starting,
 * 所以这里拿到的 `social` 一定是接上了的,处理器里不再写「没接线」的分支(以前的 SOCIAL_MODULE_OFF 兜底)。
 *
 * 不标模块的那几条(关系视图、社交总开关、入站开关)不在这里:社交关着时它们照样要能用,留在
 * daemon/internal-api/routes-social.ts。
 *
 * 心愿 (spec 2026-09-04-wish-postcard §4) replaced the P4 propose→confirm/
 * cancel seek/seeks/echoes/pledges/*reveal routes with four wish routes:
 * propose gates + stashes a draft WITHOUT sending; send broadcasts the
 * stored redacted wording verbatim to every open channel; cancel voids a
 * draft/open row; the GET list gives the redacted text + effective status
 * (never the raw text or a stale `open` past expiry).
 */
// 只要 RouteTable 这个类型(types.ts 里的),同画室:不引 internal-api/lifecycle。
import type { RouteTable } from '../../daemon/internal-api/types'
import type { PostcardRef } from './wish'
import { isIntroClaimLive } from './intro'
import { penpalRoutes } from './routes-penpal'
import type { SocialService } from './wire-social'

export interface SocialRoutesDeps {
  social: SocialService
  /** 注册表里认识这个对端就给名字(经 A2A 服务那一侧;它没起 ⇒ undefined,信箱里退回对端 id)。 */
  peerName: (agentId: string) => string | undefined
}

export function socialRoutes(d: SocialRoutesDeps): RouteTable {
  const { social } = d
  return {
    // 串门(桌面「认识的人」里的按钮)。整趟要跑两三分钟(6-7 次模型调用),
    // 不等 —— 起跑就回,结果经微信 + 日志(journal)到主人手里。
    'POST /v1/social/visit': async (_q, body) => {
      const target = ((body ?? {}) as { target?: unknown }).target
      if (target !== undefined && (typeof target !== 'string' || target === '')) return { status: 400, body: { error: 'bad_target' } }
      void social.penpal.startVisit(target as string | undefined).catch(() => { /* 失败已在 wire-visit 记日志 */ })
      return { status: 200, body: { ok: true, started: true } }
    },

    // 心愿(spec 2026-09-04-wish-postcard §4)。propose 只存草稿 —— 发出必须是主人的动作。
    'POST /v1/social/wish': async (_q, body) => {
      const text = ((body ?? {}) as { text?: unknown }).text
      if (typeof text !== 'string' || text.trim() === '') return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await social.wish.propose(text.trim()) }
    },
    'POST /v1/social/wish/send': async (_q, body) => {
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      const r = await social.wish.send(id)
      return { status: 200, body: r.ok ? { ok: true, sent_to: r.sentTo } : r }
    },
    'POST /v1/social/wish/cancel': async (_q, body) => {
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: social.wish.cancel(id) }
    },
    'GET /v1/social/wishes': async () => {
      return {
        status: 200,
        body: {
          wishes: social.wish.list().map(w => {
            const base = { id: w.id, text: w.redacted, status: w.effective, created_at: w.createdAt, expires_at: w.expiresAt, sent_to: w.sentTo, replies: w.replies }
            const postcards = w.postcards as Array<PostcardRef & { viaLabel: string }> | undefined
            // `requested` = 「已在问」这四个字要不要顶掉「想认识 TA」按钮。
            // 光看 myIntro 在不在不行:claim 和介绍人那条 pending 同一把 7 天
            // 尺子(isIntroClaimLive),过了就该重新露出按钮,不然一封丢掉的
            // card 会把这张明信片永远钉死在「已在问」上。
            return postcards
              ? { ...base, postcards: postcards.map(p => ({ reply_id: p.replyId, via_label: p.viaLabel, preview: p.preview, at: p.at, requested: isIntroClaimLive(p.myIntro, Date.now()) })) }
              : base
          }),
        },
      }
    },
    // 介绍(spec 2026-09-04-introduction)。handler 形状照上面的 wish/* 三兄弟:
    // body 里的 reply_id 非空字符串校验 → 400;service 已经把结果
    // 归一成 {ok:true, replyId} | {ok:false, reason},这里只是转成 snake_case。
    'POST /v1/social/intro/request': async (_q, body) => {
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await social.intro.request(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'POST /v1/social/intro/accept': async (_q, body) => {
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await social.intro.accept(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'POST /v1/social/intro/decline': async (_q, body) => {
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await social.intro.decline(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'GET /v1/social/intro/offers': async () => {
      return { status: 200, body: { offers: social.intro.offers().map(o => ({ reply_id: o.replyId, hint: o.hint, via_label: o.viaLabel, at: o.at })) } }
    },
    ...penpalRoutes({ penpal: social.penpal, peerName: d.peerName }),
  }
}
