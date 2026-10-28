/**
 * CC 的信(2026-10-16,letters/runtime.ts)。全部 admin:信是写给主人的私事。
 *   GET  /v1/letters            —— 开没开、有没有一封在等寄、最近写过哪些(不说下一封哪天)
 *   POST /v1/letters/write      —— 主人当面要一封(cc_letter 工具)。立刻回 started,后台写、写好就寄;
 *                                  写不成由 runtime 自己用微信告诉主人(工具调用等不了一两分钟)
 *   POST /v1/letters/settings   —— 开 / 关不定期的信
 * 由 letters 模块自己挂(internalApi.mount;路由表标了 module: 'letters')。模块没起来 ⇒ 路由层回 module_*。
 */
import { loadCompanionConfig, saveCompanionConfig } from '../../lib/companion-config'
import type { RouteTable } from '../../daemon/internal-api/types'
import type { LetterRuntime } from './runtime'
import type { LettersSettingsRequestT, LettersWriteRequestT } from '../../daemon/internal-api/schema'

export function lettersRoutes(letters: LetterRuntime, stateDir: string): RouteTable {
  return {
    'GET /v1/letters': async () => {
      return { status: 200, body: { ok: true, ...letters.status() } }
    },
    'POST /v1/letters/write': async (_q, body) => {
      const { request, preview } = (body ?? {}) as LettersWriteRequestT
      // preview:维护者自检 —— 等它写完,回图片路径与正文;不存档、不寄。
      if (preview) return { status: 200, body: { ok: true, preview: await letters.preview(request) } }
      void letters.writeNow(request).catch(() => { /* runtime 自己记日志、告诉主人 */ })
      return { status: 200, body: { ok: true, started: true } }
    },
    'POST /v1/letters/settings': async (_q, body) => {
      const { enabled } = body as LettersSettingsRequestT
      await saveCompanionConfig(stateDir, { ...loadCompanionConfig(stateDir), letters_enabled: enabled })
      return { status: 200, body: { ok: true, ...letters.status() } }
    },
  }
}
