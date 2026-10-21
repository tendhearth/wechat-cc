import { PHONE_TOPIC_NAMES, ROUTES } from '@wechat-cc/protocol/routes'

/**
 * 手机设置面板(`/set`、`/m`)令牌能走的路由,与经隧道不许做的操作(梳理第 6 步,2026-09-29)。
 *
 * 面板的令牌登记在内部 API 同一个 token-registry 里,带 routeAllow = 这里的集合。
 * 形状与内部 API 的 routeAllow 一致:`"METHOD /path"` 精确键;以 `/` 结尾的键是前缀
 * (贴纸一族)。**名单本身在路由表 `packages/protocol/src/routes.ts`**(重构第二批 5a):新加手机路由
 * 在那里加一行(`phone` / `set` 块,`link` 必填),这里的集合都是推出来的,名字和类型不变。
 * `scripts/phone-routes.guard.test.ts` 会对着 `settings-panel.ts` 的 routeRequest 与 `mobile-*.ts` 双向核对。
 *
 * 设计稿:docs/superpowers/specs/2026-09-27-device-token-registry-design.md;与之不同的
 * 两条裁决见 docs/superpowers/plans/2026-09-29-device-token-registry.md。
 */

const PANEL_ROWS = Object.entries(ROUTES).flatMap(([key, r]) => {
  const panel = r.phone ?? r.set
  return panel ? [{ key, panel }] : []
})

/** 设备令牌的 routeAllow:表里带 `phone` / `set` 的每一行(各行的注释在表里)。 */
export const PHONE_ROUTES: ReadonlySet<string> = new Set(PANEL_ROWS.map(r => r.key))

/**
 * 链接令牌与设备令牌同一套(计划裁决 1):设置页链到 `/m`,`/m` 在配对之前就用链接令牌读
 * `/m/api/*`;收窄会让「从设置链接打开随身 CC」在配对前坏掉。10 分钟内同权,与改造前相同。
 */
/**
 * /set 链接令牌(10 分钟,可能随 URL 外泄)能走的路由:手机那一套,但不含让终端会话「接着说」——
 * 那会以 daemon 的 --dangerously 姿态起一个 agent 执行任意话术(评审 10-15 #3)。拍板同理一并拿掉。
 * 「CC 的信」也拿掉(2026-10-18):信是写给主人的私事,只给配过对的设备。
 */
// chat/file 也只给设备(评审 10-19 #1):寄出去的信每一页都镜像成主人对话里的一行文件,链接令牌能从这里读出整封信,
// 等于绕过上面「信是私事」;手机网页 /m 不用这条(只有原生 App 按块下载回复里的文件)。
// 撤掉这一轮(2026-10-21)也只给设备:会丢掉工作区里的改动,不能让 10 分钟、可能外泄的链接令牌做。
// 退回 / 行评论(#456 评审):送给执行者的话就是指令 ⇒ 只给设备。review-mark 只记标记、不给执行者递话,留给链接令牌。
// 审计(2026-10-20,与 wechat-cc-2a 定):会把话 / 批准 / 新任务送到执行者那里、或会丢改动的写操作 ⇒ 只给设备。
// 主人那条 CC(chat/say)是 admin 档、默认 dangerously,能跑 shell、能委派 —— 链接一转发谁都能指挥它。推送两条处理器里本来就只认设备,这里对齐。
/**
 * 链接令牌能读的路由,每条一句理由(审计续 2026-10-20)。**白名单**:不在这里、也不在 LINK_WRITE_OK 的路由一律只给设备 ——
 * 以前是「全部减去排除名单」,新加的 GET 默认链接就能读(信、回退都是事后补的)。改成白名单时逐条保留了原来的行为;
 * 标「私事,收敛时再看」的几条是主人的对话 / 记忆 / 电脑会话,手机网页收敛(主人 10-20 拍板)时一并收紧。
 * 只给设备的那几条(信、定时、做过的事、经验、回退、对话里的文件,以及所有送话给执行者的写操作)不在任何一张表里。
 */
export const LINK_READ_OK: Readonly<Record<string, string>> = Object.fromEntries(
  PANEL_ROWS.filter(r => r.panel.link === 'read').map(r => [r.key, r.panel.reason ?? '']),
)
/**
 * 链接令牌还能做的写操作,每条一句理由(审计 2026-10-20)。`phone-routes.test.ts` 要求每条 POST 要么在
 * 「只给设备」(不在任何链接白名单里)、要么在这里 —— 新加写路由必须想清楚归哪边。
 */
export const LINK_WRITE_OK: Readonly<Record<string, string>> = Object.fromEntries(
  PANEL_ROWS.filter(r => r.panel.link === 'write').map(r => [r.key, r.panel.reason ?? '']),
)
export const LINK_ROUTES: ReadonlySet<string> = new Set([...Object.keys(LINK_READ_OK), ...Object.keys(LINK_WRITE_OK)].filter(r => PHONE_ROUTES.has(r)))

/**
 * 经隧道(`_via=tunnel`)一律拒的 `/set/api/apply` 操作:开关远程访问会重启 daemon,
 * 撤销 / 全忘设备会把人锁在门外 —— 只在家(同一局域网)做。泄露的设备令牌在外面够不着这些。
 * `unpair_self`(只撤调用者自己)不在这里:撤自己不会把别人锁在门外,手机 app 在外面也要能解除配对。
 */
export const LAN_ONLY_OPS: ReadonlySet<string> = new Set(PANEL_ROWS.flatMap(r => r.panel.lanOnlyOps ?? []))

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
export const PHONE_TOPICS: ReadonlySet<string> = new Set(PHONE_TOPIC_NAMES)

const MATTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 主题名合法性:精确命中三个固定主题,或 `matter/<id>`(id 只能是 `[A-Za-z0-9_-]{1,64}`)。 */
export function phoneTopicAllowed(topic: string): boolean {
  // 'matter/' 本身只是登记表里的前缀标记(跟 PHONE_ROUTES 同一个约定),不是可订阅的
  // 主题名 —— 精确命中要排除它,否则 `matter/` 这个裸前缀会被误判成合法主题。
  if (PHONE_TOPICS.has(topic) && topic !== 'matter/') return true
  if (topic.startsWith('matter/')) return MATTER_ID_RE.test(topic.slice('matter/'.length))
  return false
}
