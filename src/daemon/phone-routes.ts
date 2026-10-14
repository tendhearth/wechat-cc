/**
 * 手机设置面板(`/set`、`/m`)令牌能走的路由,与经隧道不许做的操作(梳理第 6 步,2026-09-29)。
 *
 * 面板的令牌登记在内部 API 同一个 token-registry 里,带 routeAllow = 这里的集合。
 * 形状与内部 API 的 routeAllow 一致:`"METHOD /path"` 精确键;以 `/` 结尾的键是前缀
 * (贴纸一族)。新加手机路由要登记在这里,`scripts/phone-routes.guard.test.ts` 会对着
 * `settings-panel.ts` 的 routeRequest 与 `mobile-workbench.ts` / `mobile-chat.ts` 双向核对。
 *
 * 设计稿:docs/superpowers/specs/2026-09-27-device-token-registry-design.md;与之不同的
 * 两条裁决见 docs/superpowers/plans/2026-09-29-device-token-registry.md。
 */

export const PHONE_ROUTES: ReadonlySet<string> = new Set([
  // 设置页
  'GET /set',
  'GET /set/api/state',
  'POST /set/api/apply',
  'POST /set/api/pair',
  // 随身 CC
  'GET /m',
  'GET /m/api/state',
  'GET /m/api/art/blink',
  'GET /m/api/art/presence',
  'GET /m/api/memory',
  // 「CC 记得你」逐条纠错(2026-10-06)
  'POST /m/api/memory/correct',
  'GET /m/api/home',
  'GET /m/api/feed',
  'POST /m/api/seen',
  'GET /m/api/matters',
  'GET /m/api/matter',
  'GET /m/api/matter/input-receipt',
  'GET /m/api/matter/insight',
  'GET /m/api/matter/changes',
  'POST /m/api/matter/say',
  // 跟 CC 说(spec 2026-10-01,mobile-chat.ts):主人对话一页 + 收下即回的说一句
  'GET /m/api/chat',
  'POST /m/api/chat/say',
  // 搜主人那条对话(2026-10-06)
  'GET /m/api/chat/search',
  // 回复里的语音附件按需合成(2026-10-04):只念库里那一行真有的那段
  'GET /m/api/chat/voice',
  // CC 回复里的文件按块读(2026-10-06)
  'GET /m/api/chat/file',
  // 主人对话用哪个后端 / 模型:读与钉(2026-10-06)
  'GET /m/api/chat/model',
  'POST /m/api/chat/model',
  // CC 的连接(spec 2026-10-01,mobile-reads.ts),去掉 detail
  'GET /m/api/connections',
  // 电脑上的原生会话(只读,spec 2026-10-01),项目只给目录名
  'GET /m/api/sessions',
  'GET /m/api/session',
  // 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions,mobile-workbench.ts):预览 + 接成一件事
  'GET /m/api/session/continue',
  'POST /m/api/session/continue',
  'POST /m/api/todo',
  'GET /m/api/sticker/',
  // 交办与材料(mobile-workbench.ts,#129)
  // 交办时可选的模型(2026-10-06)
  'GET /m/api/entry/models',
  'POST /m/api/attachment/chunk',
  'GET /m/api/attachment/upload',
  'POST /m/api/attachment/discard',
  'GET /m/api/entry/options',
  'POST /m/api/matter/create',
  'GET /m/api/matter/create-receipt',
  'POST /m/api/matter/permission',
  // 手机上停下正在跑的这一轮(2026-10-06)
  'POST /m/api/matter/stop',
  // 独立工作区:提交到分支 / 删除工作区(2026-10-07)
  'POST /m/api/matter/worktree',
  'POST /m/api/matter/answer',
  'GET /m/api/matter/artifact',
  // 额度用完 ⇒ 交给另一位执行者继续(spec 2026-10-01-tendhearth-continue-sessions §7-3,mobile-workbench.ts)
  'POST /m/api/matter/handoff',
  // 推送(中继 v2,spec 2026-09-30 §5):登记 APNs / FCM token、发一条测试通知。只认设备令牌。
  'POST /m/api/push/register',
  'POST /m/api/push/test',
])

/**
 * 链接令牌与设备令牌同一套(计划裁决 1):设置页链到 `/m`,`/m` 在配对之前就用链接令牌读
 * `/m/api/*`;收窄会让「从设置链接打开随身 CC」在配对前坏掉。10 分钟内同权,与改造前相同。
 */
export const LINK_ROUTES: ReadonlySet<string> = PHONE_ROUTES

/**
 * 经隧道(`_via=tunnel`)一律拒的 `/set/api/apply` 操作:开关远程访问会重启 daemon,
 * 撤销 / 全忘设备会把人锁在门外 —— 只在家(同一局域网)做。泄露的设备令牌在外面够不着这些。
 * `unpair_self`(只撤调用者自己)不在这里:撤自己不会把别人锁在门外,手机 app 在外面也要能解除配对。
 */
export const LAN_ONLY_OPS: ReadonlySet<string> = new Set(['set_remote', 'revoke_device', 'forget_devices'])

/**
 * 这条请求在不在令牌的 routeAllow 里。路径在册但方法不对也放行 —— 交给处理器照旧回 405
 * (计划裁决 2),门只挡「根本不在册的路径」。
 */
export function phoneRouteAllowed(allow: ReadonlySet<string>, method: string, path: string): boolean {
  const key = `${method} ${path}`
  if (allow.has(key)) return true
  for (const k of allow) {
    const p = k.slice(k.indexOf(' ') + 1)
    if (p.endsWith('/') ? path.startsWith(p) && path.length > p.length && k.startsWith(`${method} `) : p === path) return true
  }
  return false
}

/**
 * 手机能订阅的事件主题(第 9 步,phone-events.ts 的 `subscribe`)。`matter/` 以 `/` 结尾
 * 是前缀标记,跟 PHONE_ROUTES 同一个约定 —— 真正允许的是 `matter/<id>`,`phoneTopicAllowed`
 * 负责把前缀展开成"后面必须是合法 id"这条规矩。
 *
 * `scripts/phone-routes.guard.test.ts` 双向核对两件事:`PHONE_TOPICS` 与 `phoneTopicAllowed`
 * (哪个主题名允许、哪个不允许);每个主题恰好一个来源、每个来源都对得上主题
 * (`phone-topic-sources.ts`,第 11 步)。
 */
export const PHONE_TOPICS: ReadonlySet<string> = new Set(['home', 'approvals', 'agents', 'matter/'])

const MATTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 主题名合法性:精确命中三个固定主题,或 `matter/<id>`(id 只能是 `[A-Za-z0-9_-]{1,64}`)。 */
export function phoneTopicAllowed(topic: string): boolean {
  // 'matter/' 本身只是登记表里的前缀标记(跟 PHONE_ROUTES 同一个约定),不是可订阅的
  // 主题名 —— 精确命中要排除它,否则 `matter/` 这个裸前缀会被误判成合法主题。
  if (PHONE_TOPICS.has(topic) && topic !== 'matter/') return true
  if (topic.startsWith('matter/')) return MATTER_ID_RE.test(topic.slice('matter/'.length))
  return false
}
