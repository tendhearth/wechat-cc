/**
 * A2A wire-protocol version, advertised in the agent card
 * (GET /.well-known/agent.json → `proto_version`).
 *
 * Rules:
 * - Single integer; bumped ONLY on an incompatible wire change.
 * - A card WITHOUT the field means version 1 (every pre-versioning peer).
 * - Mismatch = best-effort interop + warn; never refuse (refusal/downgrade
 *   semantics get designed when a real v2 exists).
 *
 * History:
 * - v2 (2026-07-22): sync MatchReceipt echoes retired — echoes arrived via
 *   the async /a2a/echo message.
 * - v3 (2026-09-04,心愿/明信片改写): 整条 seek/echo/reveal 掮客管道退役。
 *   `/a2a/intent` `/a2a/echo` `/a2a/reveal` 三条路由连同 IntentCard /
 *   EchoMessage / MatchReceipt 的线上格式一起没了 —— 现在**只剩一条入站口**
 *   `/a2a/letter`,里面装的是信封(letter / visit / wish / postcard),
 *   按 kind 分发。v2 及更早的对端发的那三条路由会得到 404,这是有意的:
 *   老协议的东西没有降级路径,fleet 必须升级。
 */
export const A2A_PROTO_VERSION = 3
