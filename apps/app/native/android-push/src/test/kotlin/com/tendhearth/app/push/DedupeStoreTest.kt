package com.tendhearth.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 消息服务把去重表存进 SharedPreferences 的一个 JSON 字符串;坏数据 ⇒ 空表(最多多响一次),不抛。 */
class DedupeStoreTest {
  @Test fun roundTrip() {
    val a = PushDedupe()
    a.seen("1:abc", 1000)
    a.seen("2:def", 2000)
    val b = PushDedupe.fromJson(a.toJson())
    assertEquals(a.snapshot(), b.snapshot())
    assertTrue(b.seen("1:abc", 3000))
  }

  @Test fun badInputIsEmpty() {
    for (s in listOf(null, "", "nope", "[1]")) assertEquals(s.toString(), emptyMap<String, Long>(), PushDedupe.fromJson(s).snapshot())
    val d = PushDedupe.fromJson("""{"ok":5,"str":"x","bool":true,"frac":7.9}""")
    assertEquals(mapOf("ok" to 5L, "frac" to 7L), d.snapshot())
    assertFalse(d.seen("str", 10))
  }
}
