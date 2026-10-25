/**
 * 画室的路由(桌面「画室」那一块)。全部 trusted:桌面 / CLI 的 0600 文件 token。
 *   GET  /v1/atelier/works         —— 最近的画(元数据 + 小于 2MB 的 PNG 内联);画的私下缘由不出去
 *   GET  /v1/atelier/model-status  —— 第一次打开时颜料(SD-Turbo 权重)下到哪了,和画室开关
 *   POST /v1/atelier/share         —— 主人当面点「分享这幅画」:只发给 companion.default_chat_id
 * 由 atelier 模块自己挂(internalApi.mount;路由表标了 module: 'atelier')。模块没起来 ⇒ 路由层回 module_*。
 */
import { readFileSync } from 'node:fs'
import { loadCompanionConfig } from '../../lib/companion-config'
import { errMsg, type RouteTable } from '../../daemon/internal-api/types'
import type { AtelierShareRequestT } from '../../daemon/internal-api/schema'
import type { IlinkAdapter } from '../../daemon/ilink-glue'
import type { AtelierStore } from './store'
import { readModelStatus } from './provision'

export interface AtelierRoutesDeps {
  stateDir: string
  store: AtelierStore
  /** 分享那一下的两样发送(图、主人改过的背景说明)。 */
  ilink: Pick<IlinkAdapter, 'sendMessage' | 'sendFile'>
}

export function atelierRoutes(d: AtelierRoutesDeps): RouteTable {
  return {
    'GET /v1/atelier/works': async (q) => {
      const limitRaw = Number(q.get('limit') ?? 12)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(24, Math.floor(limitRaw))) : 12
      const works = d.store.list(limit).map((work) => {
        const imagePath = d.store.imagePath(work)
        let imageData: string | undefined
        try {
          if (imagePath) {
            const bytes = readFileSync(imagePath)
            if (bytes.byteLength <= 2 * 1024 * 1024) imageData = `data:image/png;base64,${bytes.toString('base64')}`
          }
        } catch { /* corrupt/missing image stays metadata-only */ }
        const { privateCauseSummary: _privateCause, ...publicWork } = work
        return { ...publicWork, ...(imageData ? { image_data: imageData } : {}) }
      })
      return { status: 200, body: { works } }
    },

    // First-enable paint-set download progress (checking/downloading/ready/
    // failed). null means the atelier has never been turned on yet.
    'GET /v1/atelier/model-status': () => {
      return { status: 200, body: { status: readModelStatus(d.stateDir), mode: loadCompanionConfig(d.stateDir).atelier_mode } }
    },

    // Explicit owner-initiated share from the desktop atelier. The target is
    // always the configured owner chat; callers cannot supply another chat id.
    // Edited background copy is send-only and never overwrites CC's original
    // local artist note. `background:null` sends the image by itself.
    'POST /v1/atelier/share': async (_q, body) => {
      const { id, background } = body as AtelierShareRequestT
      const work = d.store.load(id)
      const imagePath = work ? d.store.imagePath(work) : null
      if (!work || !imagePath) return { status: 200, body: { ok: false, error: 'artwork_not_found' } }
      if (work.shareState === 'shared') return { status: 200, body: { ok: false, error: 'already_shared' } }
      if (work.shareState === 'pending') return { status: 200, body: { ok: false, error: 'share_in_progress' } }
      const ownerChatId = loadCompanionConfig(d.stateDir).default_chat_id
      if (!ownerChatId) return { status: 200, body: { ok: false, error: 'owner_chat_not_configured' } }
      const claimed = d.store.transitionShare(id, 'private', 'pending')
      if (!claimed) return { status: 200, body: { ok: false, error: 'share_in_progress' } }
      try {
        await d.ilink.sendFile(ownerChatId, imagePath)
      } catch (err) {
        try { d.store.transitionShare(id, 'pending', 'private') } catch { /* next load exposes pending for diagnosis */ }
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }

      const sharedAt = new Date().toISOString()
      let warning: string | undefined
      try {
        if (!d.store.transitionShare(id, 'pending', 'shared', sharedAt)) warning = 'share_state_update_failed'
      } catch {
        warning = 'share_state_update_failed'
      }
      let backgroundSent = false
      if (background) {
        const note = `《${background.title}》\n\n${background.origin}\n\n${background.approach}`
        try {
          const sent = await d.ilink.sendMessage(ownerChatId, note)
          if (sent.error) warning = warning ?? 'background_send_failed'
          else backgroundSent = true
        } catch {
          warning = warning ?? 'background_send_failed'
        }
      }
      return {
        status: 200,
        body: {
          ok: true, shared_at: sharedAt, background_sent: backgroundSent,
          ...(warning ? { warning } : {}),
        },
      }
    },
  }
}
