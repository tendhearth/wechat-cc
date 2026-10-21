// @ts-check
/**
 * 执行者叫什么(收敛清单 ⑥,主人 10-21 定):名字只由 daemon 定,桌面**不存名字表**。
 * 这里只是 daemon 下发的那份名字的缓存:GET /v1/llm/health 的 `names`(六家内置 + 已注册的,
 * 每家 {displayName, settingsLabel})每次拿到就记下。还没拿到 / 老 daemon 不带 ⇒ 退回 id。
 *
 * 工作台、一件事那些数据自己带名字(providers[].displayName、agentNames),优先用数据里的;
 * 这份缓存给「AI 服务」菜单、对话页署名这类手里只有 id 的地方。
 */

/** @typedef {{displayName?:unknown,settingsLabel?:unknown}} NameEntry */

/** @type {Map<string,{displayName:string,settingsLabel:string|null}>} */
const known = new Map()

/** 记下 daemon 给的名字(`names` 字段原样传进来;不是对象就什么都不做)。 @param {unknown} names */
export function rememberExecutorNames(names) {
  if (!names || typeof names !== 'object') return
  for (const [id, v] of Object.entries(/** @type {Record<string,NameEntry>} */ (names))) {
    if (!v || typeof v.displayName !== 'string' || !v.displayName) continue
    known.set(id, { displayName: v.displayName, settingsLabel: typeof v.settingsLabel === 'string' && v.settingsLabel ? v.settingsLabel : null })
  }
}

/** 正式名字(头像旁、对话署名);不知道 ⇒ id。 @param {string} id */
export function executorName(id) {
  return known.get(id)?.displayName ?? id
}

/** 设置里写清怎么连的(「Gemini · 账号连接」);没有这一说 ⇒ 正式名字;都不知道 ⇒ id。 @param {string} id */
export function executorSettingsLabel(id) {
  const n = known.get(id)
  return n?.settingsLabel ?? n?.displayName ?? id
}

/** 已经从 daemon 拿到过名字了吗(拿到过就不用开机再要一次)。 */
export function haveExecutorNames() { return known.size > 0 }

/** 拿一次 /v1/llm/health 只为了名字(不外呼,daemon 只回上次结果)。失败就算了,界面退回 id。 @param {((method:'GET',path:string)=>Promise<any>)|undefined} invokeApi */
export async function loadExecutorNames(invokeApi) {
  const r = await invokeApi?.('GET', '/v1/llm/health').catch(() => null)
  rememberExecutorNames(r?.names)
}

/** 测试用。 */
export function __resetExecutorNames() { known.clear() }
