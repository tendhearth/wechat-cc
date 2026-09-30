package com.tendhearth.app.push

import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class PushOpenError { MALFORMED, AUTH, STALE }

sealed class PushOpenResult {
  data class Ok(val payload: JSONObject, val ct: String) : PushOpenResult()
  data class Failure(val error: PushOpenError) : PushOpenResult()
}

/**
 * 与 packages/protocol/src/push.ts 的 derivePushKey / openPush 同一算法、同一拒绝顺序:
 * 形状 → base64 → GCM 认证 → 明文是 JSON 对象 → ts 是有限数字 → 时间窗(过去 1 小时 / 未来 10 分钟,两端都含)。
 * AES-256-GCM:iv 12 字节,ct = 密文‖16 字节 tag,无 AAD。布尔不算数字(org.json 里它们是 Boolean,不是 Number)。
 * 不打日志:钥匙、明文、令牌都不出这个对象。
 */
object PushCrypto {
  const val MAX_AGE_MS = 3_600_000L
  const val MAX_SKEW_MS = 600_000L
  const val KEY_BYTES = 32
  private val INFO = "wechat-cc/push/v1".toByteArray(Charsets.UTF_8)

  /** HKDF-SHA256(ikm = utf8(deviceToken), salt = 空, info)。空盐按 RFC 5869 等价于 32 个 0 字节(javax 的 HmacSHA256 不收空钥匙)。服务本身不调用,给向量核对。 */
  fun deriveKey(deviceToken: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
    val prk = mac.doFinal(deviceToken.toByteArray(Charsets.UTF_8))
    mac.init(SecretKeySpec(prk, "HmacSHA256"))
    mac.update(INFO)
    mac.update(1.toByte())
    return mac.doFinal() // 32 字节正好是 T(1)
  }

  fun open(key: ByteArray, sealedJson: String, nowMs: Long): PushOpenResult {
    val sealed = try { JSONObject(sealedJson) } catch (e: Exception) { return fail(PushOpenError.MALFORMED) }
    return open(key, sealed, nowMs)
  }

  fun open(key: ByteArray, sealed: JSONObject, nowMs: Long): PushOpenResult {
    val v = sealed.opt("v")
    if (v !is Number || v.toDouble() != 1.0) return fail(PushOpenError.MALFORMED)
    val ivS = sealed.opt("iv") as? String ?: return fail(PushOpenError.MALFORMED)
    val ctS = sealed.opt("ct") as? String ?: return fail(PushOpenError.MALFORMED)
    val iv = Base64Url.decode(ivS) ?: return fail(PushOpenError.MALFORMED)
    val ct = Base64Url.decode(ctS) ?: return fail(PushOpenError.MALFORMED)
    if (iv.size != 12 || ct.size < 16) return fail(PushOpenError.MALFORMED)
    // 钥匙不是 32 字节 ⇒ 按认证失败处理(不让 JCE 以 AES-128 / 192 碰巧解开)。
    if (key.size != KEY_BYTES) return fail(PushOpenError.AUTH)
    val plain = try {
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
      c.doFinal(ct)
    } catch (e: Exception) {
      return fail(PushOpenError.AUTH)
    }
    val payload = try { JSONObject(String(plain, Charsets.UTF_8)) } catch (e: Exception) { return fail(PushOpenError.MALFORMED) }
    val ts = payload.opt("ts") as? Number ?: return fail(PushOpenError.MALFORMED)
    val t = ts.toDouble()
    if (!t.isFinite()) return fail(PushOpenError.MALFORMED)
    if (t < (nowMs - MAX_AGE_MS).toDouble() || t > (nowMs + MAX_SKEW_MS).toDouble()) return fail(PushOpenError.STALE)
    return PushOpenResult.Ok(payload, ctS)
  }

  private fun fail(e: PushOpenError) = PushOpenResult.Failure(e)
}
