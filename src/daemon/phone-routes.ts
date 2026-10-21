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
  // 手机逐文件审阅(2026-10-17):没问题 / 退回(同桌面 review-mark / review-return);退回只给设备(不在链接白名单里)
  'POST /m/api/matter/review-mark',
  'POST /m/api/matter/review-return',
  // 行评论(切片 4,2026-10-21):整块评论建 / 删 + 发出;只给设备(不在链接白名单里)
  'POST /m/api/matter/review-comment',
  'POST /m/api/matter/review-comments-send',
  // 撤掉这一轮(回退切片 4,2026-10-21):预览 + 带 token 执行;只给设备(不在链接白名单里)
  'GET /m/api/matter/rewind',
  'POST /m/api/matter/rewind',
  'POST /m/api/matter/say',
  // 跟 CC 说(spec 2026-10-01,mobile-chat.ts):主人对话一页 + 收下即回的说一句
  'GET /m/api/chat',
  'POST /m/api/chat/say',
  // 搜主人那条对话(2026-10-06)
  'GET /m/api/chat/search',
  // 回复里的语音附件按需合成(2026-10-04):只念库里那一行真有的那段
  'GET /m/api/chat/voice',
  // 按住说话(2026-10-18):配没配语音转文字 + 一段录音转成字(只回字,不发、不执行;链接令牌也能用)
  'GET /m/api/chat/transcribe',
  'POST /m/api/chat/transcribe',
  // CC 回复里的文件按块读(2026-10-06)
  'GET /m/api/chat/file',
  // CC 的信(2026-10-18,mobile-letters.ts):寄出去了的信 + 一页 PNG 按块读。信是私事:链接令牌不在册(见 LINK_ROUTES)
  'GET /m/api/letters',
  // 定时(对标 B7,2026-10-20):只给设备
  'GET /m/api/activity',
  'GET /m/api/lessons',
  'POST /m/api/lessons/add',
  'POST /m/api/lessons/remove',
  'GET /m/api/jobs',
  'POST /m/api/jobs/action',
  'GET /m/api/letters/page',
  // 主人对话用哪个后端 / 模型:读与钉(2026-10-06)
  'GET /m/api/chat/model',
  'POST /m/api/chat/model',
  // CC 的连接(spec 2026-10-01,mobile-reads.ts),去掉 detail
  'GET /m/api/connections',
  // 电脑上的原生会话(只读,spec 2026-10-01),项目只给目录名
  'GET /m/api/sessions',
  'GET /m/api/session',
  // 终端会话登记处(v76,2026-10-14):主人在 CC 外面开的 claude / codex 会话 —— 谁在跑、谁在等批准
  'GET /m/api/cli/sessions',
  // 手机上拍板终端会话等批准的那一项(同微信「y/n 码」)、接着说一句(同微信「@码」)(2026-10-14)
  'POST /m/api/cli/permission',
  'POST /m/api/cli/say',
  // 看着它跑(2026-10-17):一条终端会话最近几步(跑了什么、改了哪、说了什么),只读
  'GET /m/api/cli/activity',
  // 「今天」一眼看完(2026-10-14):终端 + 一起做,过去 24 小时;与微信「日报」同一份
  'GET /m/api/today',
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
export const LINK_READ_OK: Readonly<Record<string, string>> = {
  'GET /set': '设置页本身(配对就从这里开始)',
  'GET /set/api/state': '设置页要显示的状态',
  'GET /m': '手机页面本身(配对之前也要能打开)',
  'GET /m/api/state': '页面骨架:在不在、配对条、待办',
  'GET /m/api/art/blink': 'CC 的形象画(眨眼)',
  'GET /m/api/art/presence': 'CC 的形象画(在不在身边)',
  'GET /m/api/sticker/': '回复里的贴纸图片',
  'GET /m/api/home': '此刻页的内容(只读)',
  'GET /m/api/feed': '此刻页的动态',
  'GET /m/api/today': '「今天」一眼看完',
  'GET /m/api/connections': 'CC 的连接(已去掉细节)',
  'GET /m/api/matters': '一起做的列表',
  'GET /m/api/matter': '一件事的详情',
  'GET /m/api/matter/insight': '一件事的进展说明',
  'GET /m/api/matter/changes': '一件事的改动(只读)',
  'GET /m/api/matter/artifact': '一件事的成果(只读)',
  'GET /m/api/matter/input-receipt': '查补充有没有送到(本身送不出话)',
  'GET /m/api/matter/create-receipt': '查交办有没有收下(本身建不了事)',
  'GET /m/api/entry/options': '交办表单的选项(交办本身只给设备)',
  'GET /m/api/entry/models': '交办时可选的模型(交办本身只给设备)',
  'GET /m/api/attachment/upload': '查上传进度(材料没有 create / say 就送不出去)',
  'GET /m/api/chat/transcribe': '有没有配语音转文字',
  'GET /m/api/chat/model': '对话现在用哪个后端(改它在 LINK_WRITE_OK)',
  'GET /m/api/chat': '主人对话的记录 —— 私事,收敛时再看',
  'GET /m/api/chat/search': '搜主人对话 —— 私事,收敛时再看',
  'GET /m/api/chat/voice': '回复里的语音 —— 私事,收敛时再看',
  'GET /m/api/memory': 'CC 眼中的你 —— 私事,收敛时再看',
  'GET /m/api/sessions': '电脑上的会话列表(项目只给目录名)—— 收敛时再看',
  'GET /m/api/session': '一条电脑会话(只读)—— 收敛时再看',
  'GET /m/api/session/continue': '接着做的预览(接成一件事只给设备)—— 收敛时再看',
  'GET /m/api/cli/sessions': '终端会话登记处 —— 收敛时再看',
  'GET /m/api/cli/activity': '终端会话最近几步 —— 收敛时再看',
}
/**
 * 链接令牌还能做的写操作,每条一句理由(审计 2026-10-20)。`phone-routes.test.ts` 要求每条 POST 要么在
 * 「只给设备」(不在任何链接白名单里)、要么在这里 —— 新加写路由必须想清楚归哪边。
 */
export const LINK_WRITE_OK: Readonly<Record<string, string>> = {
  'POST /set/api/apply': '设置页本身;开关远程 / 撤设备这类在 LAN_ONLY_OPS 另有一道',
  'POST /set/api/pair': '用链接换设备令牌,就是配对这一步',
  'POST /m/api/memory/correct': '只把一条记忆标成不对 / 过时,不给执行者下令',
  'POST /m/api/seen': '只记哪些消息已经看过',
  'POST /m/api/todo': '只改待办状态',
  'POST /m/api/matter/review-mark': '只记「没问题」标记,不往执行者送话',
  'POST /m/api/matter/stop': '停下是安全方向:能停,不能让它多做什么',
  'POST /m/api/chat/model': '改用哪个后端 / 模型,有费用影响但不是指令',
  'POST /m/api/chat/transcribe': '录音转成字,只回字,不发、不执行',
  'POST /m/api/attachment/chunk': '只是材料;没有 create / say 就送不出去',
  'POST /m/api/attachment/discard': '丢掉自己传的材料',
}
export const LINK_ROUTES: ReadonlySet<string> = new Set([...Object.keys(LINK_READ_OK), ...Object.keys(LINK_WRITE_OK)].filter(r => PHONE_ROUTES.has(r)))

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
