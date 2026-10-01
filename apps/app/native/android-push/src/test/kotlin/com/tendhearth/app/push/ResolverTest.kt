package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 消息服务的整条决定(TendhearthMessagingService 只负责读密钥、去重存储与发通知),与 Swift 的 ResolverTests 对齐:
 * 任何一步不成立 ⇒ 中性占位,从不显示载荷里的原始标题 / 正文;去重键只在解开且合 PushPlaintext 之后才算。
 */
class ResolverTest {
  private val v = loadJson("packages/protocol/vectors/push.json")
  private val strings: Map<String, Map<String, String>> = loadJson("apps/app/native/push-strings.json").let { o ->
    o.keySet().associateWith { lang -> o.getJSONObject(lang).let { t -> t.keySet().associateWith { t.getString(it) } } }
  }
  private fun case(name: String): JSONObject {
    val cases = v.getJSONArray("cases")
    return (0 until cases.length()).map { cases.getJSONObject(it) }.first { it.getString("name") == name }
  }
  private fun record(lang: String? = "en", token: String = v.getString("deviceToken")) = PushKeyRecord(PushCrypto.deriveKey(token), lang)
  private fun resolve(c: JSONObject, rec: PushKeyRecord?, system: String = "en-US", seen: (String) -> Boolean = { false }): Pair<PushResolution, List<String>> {
    val asked = mutableListOf<String>()
    val r = PushResolver.resolve(rec, c.getJSONObject("sealed").toString(), system, c.getLong("now"), strings) { asked.add(it); seen(it) }
    return r to asked
  }

  @Test fun okShowsLocalisedDisplayAndAsksDedupeWithVectorKey() {
    val c = case("ok")
    val (r, asked) = resolve(c, record())
    assertEquals(PushPresenter.display(PushMessage.parse(c.getJSONObject("payload"))!!, "en", strings), r.display)
    assertFalse(r.duplicate)
    assertEquals(listOf(c.getString("dedupeKey")), asked)
    assertEquals("decide", r.display.channel)
  }

  @Test fun duplicateIsFlagged() {
    val (r, _) = resolve(case("ok"), record()) { true }
    assertTrue(r.duplicate)
  }

  @Test fun recordLangWinsThenSystem() {
    val c = case("ok")
    assertEquals("需要你批准", resolve(c, record(lang = "zh-Hans")).first.display.title)
    assertEquals("Needs your approval", resolve(c, record(lang = "en"), system = "zh-Hans-CN").first.display.title)
    assertEquals("需要你批准", resolve(c, record(lang = null), system = "zh-Hans-CN").first.display.title)
    assertEquals("CC 有新动态", resolve(case("auth-wrong-key"), null, system = "zh-Hans-CN").first.display.body)
    assertEquals("CC 有新动态", resolve(case("auth-tampered"), record(lang = "zh-Hans")).first.display.body)
  }

  @Test fun everyFailureIsThePlaceholderAndNeverTouchesDedupe() {
    val placeholder = PushPresenter.placeholder("en", strings)
    val failures = listOf(
      "ok" to null,                                      // 没有密钥记录
      "ok" to record(token = "someone-else"),            // 错钥
      "auth-tampered" to record(),
      "stale-past-61min" to record(),
      "stale-future-11min" to record(),
      "malformed-v2" to record(),
      "invalid-kind" to record(),                        // 解开了,但明文不合 PushPlaintext
    )
    for ((name, rec) in failures) {
      val (r, asked) = resolve(case(name), rec)
      assertEquals(name, placeholder, r.display)
      assertFalse(name, r.duplicate)
      assertEquals(name, emptyList<String>(), asked)
      assertEquals(name, null, r.display.deepLink)
    }
    // data 里没有 wcc / wcc 不是 JSON 对象
    for (wcc in listOf(null, "x", "[1]", "")) {
      val r = PushResolver.resolve(record(), wcc, "en", 0, strings) { throw AssertionError("dedupe asked for $wcc") }
      assertEquals(placeholder, r.display)
    }
  }

  @Test fun placeholderUsesRecordLang() {
    assertEquals(PushResolution(PushPresenter.placeholder("zh-Hans", strings), false), PushResolver.placeholder(record(lang = "zh-Hans"), "en", strings))
  }
}
