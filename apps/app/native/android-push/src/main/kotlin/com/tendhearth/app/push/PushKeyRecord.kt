package com.tendhearth.app.push

import org.json.JSONObject

/** app 写进 expo-secure-store 的推送密钥记录:{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}(src/push/key-store.ts)。 */
class PushKeyRecord(val key: ByteArray, val lang: String?) {
  companion object {
    fun parse(s: String): PushKeyRecord? = try {
      val o = JSONObject(s)
      val v = o.opt("v")
      val key = (o.opt("key") as? String)?.let { Base64Url.decode(it) }
      if (v !is Number || v.toDouble() != 1.0 || key == null || key.size != 32) null
      else PushKeyRecord(key, (o.opt("lang") as? String)?.takeIf { it == "en" || it == "zh-Hans" })
    } catch (e: Exception) {
      null
    }
  }
}
