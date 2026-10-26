// @ts-check
/**
 * 读不到 daemon 时说什么(架构终态 F6):桌面读写主人私事改走 daemon 的 /v1 以后,daemon 没起 ⇒ 这些页面读不到,
 * 统一说这一句(和首页「CC 没在运行」同一个说法),不把宿主的原始报错甩给主人。没有副作用,哪个模块都能引。
 */
/** 读不到 daemon 时各页面统一说的那一句(和首页「CC 没在运行」同一个说法)。 */
export const DAEMON_DOWN_TEXT = "CC 没在运行，启动以后再看。"

/**
 * 架构终态 F6 起,桌面读写主人私事走 daemon 的 /v1(经宿主代理 daemon_request 或 api.js);daemon 没起时报的是这几种:
 * 宿主读不到 internal-api-info.json(`read …internal-api-info.json: …`)/ 连不上(`request error: …`),(超时不算:daemon 在、只是慢)
 * api.js 的 `daemon not running …`,dev 代理的 `workbench_connection_unavailable` / `daemon info unavailable`。
 * @param {string} msg
 */
export function isDaemonDownError(msg) {
  return /internal-api-info\.json|^request error:|daemon not running|workbench_connection_unavailable|daemon info unavailable/.test(msg)
}

/**
 * 页面上「读取失败：…」那一格用:daemon 没起 ⇒ 那一句;别的照旧是原始报错。
 * @param {unknown} err
 */
export function daemonErrorText(err) {
  const msg = String(/** @type {any} */ (err)?.message ?? err ?? "未知错误")
  return isDaemonDownError(msg) ? DAEMON_DOWN_TEXT : msg
}
