package com.tendhearth.app.push

data class PushResolution(val display: PushDisplay, val duplicate: Boolean)

/**
 * 消息服务的整条决定(spec §7),纯逻辑,JVM 单测覆盖(与 Swift 的 PushResolver 对齐):
 * 没有 / 不合法的密钥记录、data 里没有 wcc、解不开(形状、认证、时间窗)、明文不合 PushPlaintext ⇒ 一律中性占位,
 * 从不回退到载荷里的任何原始文字。去重只在解开且合形状之后才问(`seen` 记下并回答是否见过)。
 */
object PushResolver {
  fun placeholder(record: PushKeyRecord?, systemTag: String, strings: Map<String, Map<String, String>>) =
    PushResolution(PushPresenter.placeholder(PushPresenter.lang(record?.lang, systemTag), strings), false)

  fun resolve(
    record: PushKeyRecord?,
    wcc: String?,
    systemTag: String,
    nowMs: Long,
    strings: Map<String, Map<String, String>>,
    seen: (String) -> Boolean,
  ): PushResolution {
    if (record == null || wcc == null) return placeholder(record, systemTag, strings)
    val opened = PushCrypto.open(record.key, wcc, nowMs) as? PushOpenResult.Ok ?: return placeholder(record, systemTag, strings)
    val msg = PushMessage.parse(opened.payload) ?: return placeholder(record, systemTag, strings)
    val lang = PushPresenter.lang(record.lang, systemTag)
    val dup = seen(PushDedupe.key(msg.ts, opened.ct))
    return PushResolution(PushPresenter.display(msg, lang, strings), dup)
  }
}
