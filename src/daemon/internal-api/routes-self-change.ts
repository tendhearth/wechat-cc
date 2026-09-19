/**
 * routes-self-change.ts — 自改流水线的三个抓手(spec 2026-09-18-self-change-pipeline §daemon 侧)。
 *
 * 自改跑在 daemon 外面的一个 CLI 进程里,这三条是它唯一能碰主人的地方:
 * 报一句进展、问一个 y/n、过一会儿回来看拍板结果。真正的机器在
 * ../self-change-glue.ts,这里只做校验和状态码。
 *
 * 分级 admin:往主人微信里发东西、替主人开一张 y/n 卡片,都是主人本人的事
 * (和 /v1/permissions/resolve、/v1/companion/converse 同一档)。
 * 校验内联(不进 schema.ts),照 routes-permissions.ts 的先例。
 */
import type { InternalApiDeps, RouteTable } from './types'

const MAX_TEXT = 4000
const MIN_TIMEOUT_MS = 60_000
/** 48 小时:自改可能跑一整夜,主人第二天早上才看手机。 */
const MAX_TIMEOUT_MS = 172_800_000

const notWired = { status: 503, body: { error: 'self_change_not_wired' } }
const badRequest = { status: 400, body: { error: 'bad_request' } }

function okText(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT
}

export function selfChangeRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/self-change/notice': async (_query, body) => {
      if (!deps.selfChange) return notWired
      const b = (body ?? {}) as { text?: unknown }
      if (!okText(b.text)) return badRequest
      const r = await deps.selfChange.notice(b.text)
      if (r.ok) return { status: 200, body: { ok: true } }
      // 409:还没配主人 chat(扫码前 / 配置丢了)—— 调用方该收工,不是重试。
      // 502:发是发了,微信那头没收下(多半是主动推送窗口关着)。
      return { status: r.error === 'owner_chat_unknown' ? 409 : 502, body: { error: r.error } }
    },

    'POST /v1/self-change/ask': async (_query, body) => {
      if (!deps.selfChange) return notWired
      const b = (body ?? {}) as { prompt?: unknown; timeoutMs?: unknown }
      if (!okText(b.prompt)) return badRequest
      const t = b.timeoutMs
      if (typeof t !== 'number' || !Number.isInteger(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) return badRequest
      const r = await deps.selfChange.ask(b.prompt, t)
      if (!r.ok) return { status: 409, body: { error: r.error } }
      // code 是主人在微信里回的两位数(「y 07」);同时只有一条待批时回「y」也行。
      return { status: 200, body: { hash: r.hash, code: r.code } }
    },

    'GET /v1/self-change/decision': async (query) => {
      if (!deps.selfChange) return notWired
      const hash = query.get('hash')
      if (!hash) return badRequest
      return { status: 200, body: { decision: deps.selfChange.decision(hash) } }
    },
  }
}
