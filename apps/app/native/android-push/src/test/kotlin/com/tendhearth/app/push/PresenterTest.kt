package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresenterTest {
  private val strings: Map<String, Map<String, String>> = loadJson("apps/app/native/push-strings.json").let { o ->
    o.keySet().associateWith { lang -> o.getJSONObject(lang).let { t -> t.keySet().associateWith { t.getString(it) } } }
  }
  private fun okMessage(): PushMessage {
    val cases = loadJson("packages/protocol/vectors/push.json").getJSONArray("cases")
    val ok = (0 until cases.length()).map { cases.getJSONObject(it) }.first { it.getString("name") == "ok" }
    return PushMessage.parse(ok.getJSONObject("payload"))!!
  }

  @Test fun bothLanguagesHaveTheSameKeys() {
    assertEquals(strings.getValue("en").keys, strings.getValue("zh-Hans").keys)
  }

  @Test fun permissionLocalisedByKindBodyPassesThrough() {
    val m = okMessage()
    val zh = PushPresenter.display(m, "zh-Hans", strings)
    assertEquals("需要你批准", zh.title)
    assertEquals(m.body, zh.body)
    assertEquals("decide", zh.channel)
    assertEquals("tendhearth://push-open?kind=permission&taskId=t-42&requestId=r-7", zh.deepLink)
    assertEquals("t-42".hashCode(), zh.notificationId)
    assertEquals("Needs your approval", PushPresenter.display(m, "en", strings).title)
  }

  @Test fun testKindAndPlaceholder() {
    val t = PushMessage(1.0, "test", "CC", "这是一条测试通知", null, null)
    val d = PushPresenter.display(t, "en", strings)
    assertEquals("Notifications reach this phone.", d.body)
    assertEquals("updates", d.channel)
    assertEquals("tendhearth://push-open?kind=test", d.deepLink)
    val p = PushPresenter.placeholder("zh-Hans", strings)
    assertEquals("CC 有新动态", p.body)
    assertNull(p.deepLink)
  }

  @Test fun channelsByKind() {
    fun ch(kind: String) = PushMessage(1.0, kind, "t", "b", null, null).channel
    assertEquals(listOf("decide", "decide", "updates", "updates", "updates"),
      listOf("permission", "question", "task_done", "task_failed", "test").map(::ch))
  }

  @Test fun languagePick() {
    assertEquals("zh-Hans", PushPresenter.lang("zh-Hans", "en-GB"))
    assertEquals("zh-Hans", PushPresenter.lang(null, "zh-Hant-TW"))
    assertEquals("en", PushPresenter.lang(null, "en-GB"))
    assertEquals("en", PushPresenter.lang("fr", "fr-FR"))
  }

  @Test fun deepLinkEncodesValues() {
    val m = PushMessage(1.0, "question", "t", "b", "ab12cd34", "q 1&x")
    assertEquals("tendhearth://push-open?kind=question&taskId=ab12cd34&requestId=q+1%26x", m.deepLink())
  }

  @Test fun messageParseMatchesZodShape() {
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"approval_needed","title":"t","body":"b"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":"x","kind":"test","title":"t","body":"b"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":true,"kind":"test","title":"t","body":"b"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t","body":"b","taskId":null}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t","body":"b","requestId":7}""")))
    assertEquals(PushMessage(1.0, "test", "t", "b", null, null),
      PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t","body":"b","extra":1}""")))
  }

  @Test fun keyRecord() {
    val v = loadJson("packages/protocol/vectors/push.json")
    val rec = PushKeyRecord.parse("""{"v":1,"key":"${v.getString("key")}","lang":"zh-Hans"}""")!!
    assertEquals(b64u(PushCrypto.deriveKey(v.getString("deviceToken"))), b64u(rec.key))
    assertEquals("zh-Hans", rec.lang)
    assertNull(PushKeyRecord.parse("""{"v":1,"key":"AAAA","lang":null}"""))
    assertNull(PushKeyRecord.parse("not json"))
    assertNull(PushKeyRecord.parse("""{"v":true,"key":"${v.getString("key")}","lang":null}"""))
    assertNull(PushKeyRecord.parse("""{"v":1,"key":"${v.getString("key")}","lang":"fr"}""")!!.lang)
  }
}
