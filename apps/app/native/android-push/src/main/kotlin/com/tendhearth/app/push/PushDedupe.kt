package com.tendhearth.app.push

import java.security.MessageDigest
import kotlin.math.floor

/** 与 packages/protocol 的 pushDedupeKey / makePushDedupe 同一规则(向量 dedupe.steps 钉住)。 */
class PushDedupe(initial: Map<String, Long> = emptyMap()) {
  private val entries = LinkedHashMap(initial)

  fun snapshot(): Map<String, Long> = HashMap(entries)

  /** true = 见过(重复,不再提醒);false = 新的,已记下。 */
  fun seen(key: String, nowMs: Long): Boolean {
    entries.entries.removeAll { nowMs - it.value > TTL_MS }
    if (entries.containsKey(key)) return true
    entries[key] = nowMs
    while (entries.size > CAPACITY) {
      val oldest = entries.entries.minWith(OLDEST_FIRST).key
      entries.remove(oldest)
    }
    return false
  }

  companion object {
    const val CAPACITY = 64
    const val TTL_MS = PushCrypto.MAX_AGE_MS + PushCrypto.MAX_SKEW_MS

    /** 记下时刻升序,平局按键名的码点升序(String.compareTo 比的是 UTF-16 码元,代理对会排错,所以不用它)。 */
    private val OLDEST_FIRST = Comparator<Map.Entry<String, Long>> { a, b ->
      val byTime = a.value.compareTo(b.value)
      if (byTime != 0) byTime else compareCodePoints(a.key, b.key)
    }

    private fun compareCodePoints(a: String, b: String): Int {
      var i = 0
      var j = 0
      while (i < a.length && j < b.length) {
        val ca = a.codePointAt(i)
        val cb = b.codePointAt(j)
        if (ca != cb) return ca.compareTo(cb)
        i += Character.charCount(ca)
        j += Character.charCount(cb)
      }
      return (a.length - i).compareTo(b.length - j)
    }

    /**
     * floor(ts) 按十进制整数格式化(不能用 Double.toString:它会出 1.700000000123E12)+ ":" + sha256(ct 原文)前 32 位 hex。
     * 调用方在 open 成功之后算(那时 ts 已是窗口内的有限数字);即便传进 NaN / ±∞ / 超出 Long 的值也不抛:
     * NaN ⇒ 0,其余饱和到 Long 的上下限(Kotlin 的 Double.toLong 语义)。
     */
    fun key(ts: Double, ct: String): String {
      val d = MessageDigest.getInstance("SHA-256").digest(ct.toByteArray(Charsets.UTF_8))
      val hex = d.joinToString("") { "%02x".format(it) }
      val whole: Long = if (ts.isNaN()) 0L else floor(ts).toLong()
      return "$whole:${hex.take(32)}"
    }
  }
}
