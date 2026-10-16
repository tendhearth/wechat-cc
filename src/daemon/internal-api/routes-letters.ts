/**
 * CC 的信(2026-10-16,letters/runtime.ts)。全部 admin:信是写给主人的私事。
 *   GET  /v1/letters            —— 开没开、有没有一封在等寄、最近写过哪些(不说下一封哪天)
 *   POST /v1/letters/write      —— 主人当面要一封(cc_letter 工具)。立刻回 started,后台写、写好就寄;
 *                                  写不成由 runtime 自己用微信告诉主人(工具调用等不了一两分钟)
 *   POST /v1/letters/settings   —— 开 / 关不定期的信
 */
import { loadCompanionConfig, saveCompanionConfig } from '../companion/config'
import type { InternalApiDeps, RouteTable } from './types'
import type { LettersSettingsRequestT, LettersWriteRequestT } from './schema'

export function lettersRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/letters': async () => {
      if (!deps.letters) return { status: 503, body: { error: 'letters_not_wired' } }
      return { status: 200, body: { ok: true, ...deps.letters.status() } }
    },
    'POST /v1/letters/write': async (_q, body) => {
      if (!deps.letters) return { status: 503, body: { error: 'letters_not_wired' } }
      const { request, preview } = (body ?? {}) as LettersWriteRequestT
      // preview:维护者自检 —— 等它写完,回图片路径与正文;不存档、不寄。
      if (preview) return { status: 200, body: { ok: true, preview: await deps.letters.preview(request) } }
      void deps.letters.writeNow(request).catch(() => { /* runtime 自己记日志、告诉主人 */ })
      return { status: 200, body: { ok: true, started: true } }
    },
    'POST /v1/letters/settings': async (_q, body) => {
      if (!deps.letters) return { status: 503, body: { error: 'letters_not_wired' } }
      const { enabled } = body as LettersSettingsRequestT
      await saveCompanionConfig(deps.stateDir, { ...loadCompanionConfig(deps.stateDir), letters_enabled: enabled })
      return { status: 200, body: { ok: true, ...deps.letters.status() } }
    },
  }
}
