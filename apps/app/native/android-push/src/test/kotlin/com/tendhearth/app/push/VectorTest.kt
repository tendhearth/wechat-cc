package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 仓库根:从 Gradle 的工作目录(native/android-push)往上找 packages/protocol/vectors/push.json。 */
val repoRoot: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
  .first { File(it, "packages/protocol/vectors/push.json").exists() }

fun loadJson(rel: String) = JSONObject(File(repoRoot, rel).readText())
fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

class VectorTest {
  private val v = loadJson("packages/protocol/vectors/push.json")

  @Test fun deriveKeyMatchesRegressionVector() {
    assertEquals(v.getString("key"), b64u(PushCrypto.deriveKey(v.getString("deviceToken"))))
  }

  @Test fun everyCase() {
    val key = PushCrypto.deriveKey(v.getString("deviceToken"))
    val wrong = PushCrypto.deriveKey(v.getString("deviceToken") + "x")
    val cases = v.getJSONArray("cases")
    assertTrue(cases.length() >= 8)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val k = if (c.optBoolean("wrongKey")) wrong else key
      // FCM 的 data.wcc 是 JSON 字符串:按线上形状传字符串。
      val r = PushCrypto.open(k, c.getJSONObject("sealed").toString(), c.getLong("now"))
      when (c.getString("expect")) {
        "ok" -> {
          assertTrue(name, r is PushOpenResult.Ok)
          val ok = r as PushOpenResult.Ok
          val got = PushMessage.parse(ok.payload)
          assertNotNull(name, got)
          assertEquals(name, PushMessage.parse(c.getJSONObject("payload")), got)
          assertEquals(name, c.getString("dedupeKey"), PushDedupe.key(got!!.ts, ok.ct))
        }
        "invalid" -> {
          assertTrue(name, r is PushOpenResult.Ok)
          assertNull(name, PushMessage.parse((r as PushOpenResult.Ok).payload))
        }
        "stale" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.STALE), r)
        "auth" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.AUTH), r)
        "malformed" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.MALFORMED), r)
        else -> throw AssertionError("unknown expect in $name")
      }
    }
  }

  @Test fun dedupeSteps() {
    val d = v.getJSONObject("dedupe")
    assertEquals(PushDedupe.CAPACITY, d.getInt("capacity"))
    assertEquals(PushDedupe.TTL_MS, d.getLong("ttlMs"))
    val store = PushDedupe()
    val steps = d.getJSONArray("steps")
    for (i in 0 until steps.length()) {
      val s = steps.getJSONObject(i)
      val dup = store.seen(s.getString("key"), s.getLong("now"))
      assertEquals(s.getString("note"), s.getString("expect"), if (dup) "duplicate" else "new")
    }
  }

  /** 小数 ts 先向下取整再按普通整数格式化(Kotlin 的 Double.toString 会出 1.700000000123E12,不能用)。 */
  @Test fun dedupeKeyCases() {
    val cases = v.getJSONArray("dedupeKeyCases")
    assertTrue(cases.length() >= 3)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.getString("note"), c.getString("key"), PushDedupe.key(c.getDouble("ts"), c.getString("ct")))
    }
  }

  /** 去重键由调用方在 open 成功之后算(那时 ts 已是有限数字);即便传进非有限 / 超范围的 ts 也不能崩。 */
  @Test fun dedupeKeyNeverThrowsOnOddTs() {
    for (ts in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 1e300, -1e300)) {
      val k = PushDedupe.key(ts, "abc")
      assertTrue("$ts -> $k", k.endsWith(":ba7816bf8f01cfea414140de5dae2223"))
      assertFalse("$ts -> $k", k.contains('E') || k.contains('.'))
    }
    assertEquals("0:ba7816bf8f01cfea414140de5dae2223", PushDedupe.key(-0.0, "abc"))
    assertEquals("-1:ba7816bf8f01cfea414140de5dae2223", PushDedupe.key(-0.5, "abc"))
  }

  @Test fun dedupeEvictsOldestWhenFull() {
    val store = PushDedupe()
    for (i in 0 until PushDedupe.CAPACITY) store.seen("k%03d".format(i), 1000L + i)
    assertFalse(store.seen("new", 5000))
    assertEquals(PushDedupe.CAPACITY, store.snapshot().size)
    assertNull(store.snapshot()["k000"])
    assertTrue(store.seen("k001", 5001))
  }

  /** 同刻平局按码点升序先删(rules):U+FFFF < U+1F600,而按 UTF-16 码元比会反过来。 */
  @Test fun dedupeTieBreakByCodePoint() {
    val initial = (0 until PushDedupe.CAPACITY - 2).associate { "k%03d".format(it) to 100L } +
      mapOf("￿" to 1L, "😀" to 1L)
    val store = PushDedupe(initial)
    assertFalse(store.seen("new", 100))
    assertNull(store.snapshot()["￿"])
    assertEquals(1L, store.snapshot()["😀"])
  }

  /** 持久化回来的初始表同样按规则修剪 / 命中,snapshot 是副本。 */
  @Test fun dedupeFromInitialMap() {
    val store = PushDedupe(mapOf("a" to 1000L, "b" to 2000L))
    assertTrue(store.seen("a", 1000L + PushDedupe.TTL_MS))
    assertFalse(store.seen("a", 1001L + PushDedupe.TTL_MS))
    assertEquals(setOf("a", "b"), store.snapshot().keys)
    assertEquals(1001L + PushDedupe.TTL_MS, store.snapshot()["a"])
    val snap = store.snapshot()
    store.seen("c", 1001L + PushDedupe.TTL_MS)
    assertNull(snap["c"])
  }

  @Test fun malformedShapes() {
    val key = PushCrypto.deriveKey("t")
    val m = PushOpenResult.Failure(PushOpenError.MALFORMED)
    assertEquals(m, PushCrypto.open(key, "not json", 0))
    assertEquals(m, PushCrypto.open(key, "[1]", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":true,"iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":"1","iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":1,"iv":"!!","ct":"AAAA"}""", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":1,"iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
  }

  private fun sealWith(key: ByteArray, plain: String): String {
    val iv = ByteArray(12) { it.toByte() }
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
    return JSONObject().put("v", 1).put("iv", b64u(iv)).put("ct", b64u(ct)).toString()
  }

  /** 钥匙必须正好 32 字节:16 字节(AES-128 合法)封好的包也按认证失败处理,不能靠 JCE 碰巧放行。 */
  @Test fun keyMustBe32Bytes() {
    val short = ByteArray(16) { 7 }
    val sealed = sealWith(short, """{"ts":1000,"kind":"test","title":"t","body":"b"}""")
    assertEquals(PushOpenResult.Failure(PushOpenError.AUTH), PushCrypto.open(short, sealed, 1000))
    assertEquals(PushOpenResult.Failure(PushOpenError.AUTH), PushCrypto.open(ByteArray(0), sealed, 1000))
    // 形状错仍先报 malformed(拒绝顺序:形状 → base64 → 认证)。
    assertEquals(PushOpenResult.Failure(PushOpenError.MALFORMED), PushCrypto.open(short, """{"v":2,"iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
  }

  /** 解开之后:明文不是对象 / ts 不是数字(布尔也不算) ⇒ malformed;明文可以合法但 ts 非有限。 */
  @Test fun plaintextShapeAfterAuth() {
    val key = PushCrypto.deriveKey("t")
    val m = PushOpenResult.Failure(PushOpenError.MALFORMED)
    assertEquals(m, PushCrypto.open(key, sealWith(key, "[1]"), 1000))
    assertEquals(m, PushCrypto.open(key, sealWith(key, "not json"), 1000))
    assertEquals(m, PushCrypto.open(key, sealWith(key, """{"ts":true}"""), 1000))
    assertEquals(m, PushCrypto.open(key, sealWith(key, """{"ts":"1000"}"""), 1000))
    assertEquals(m, PushCrypto.open(key, sealWith(key, """{"ts":1e400}"""), 1000))
    assertTrue(PushCrypto.open(key, sealWith(key, """{"ts":1000.5}"""), 1000) is PushOpenResult.Ok)
  }
}
