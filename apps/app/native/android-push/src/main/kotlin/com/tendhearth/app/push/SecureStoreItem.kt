package com.tendhearth.app.push

import org.json.JSONObject

/**
 * expo-secure-store(57.x)写进 SharedPreferences「SecureStore」的一条记录(SecureStoreModule.saveEncryptedItem + AESEncryptor):
 * {"ct":"<base64>","iv":"<base64>","tlen":128,"scheme":"aes","usesKeystoreSuffix":true,"keystoreAlias":"<service>","requireAuthentication":false}。
 * 只认我们写的那种:AES 方案、带后缀的 Keystore 别名、不要求认证、tag ≥ 96 位;其余 ⇒ null(消息服务显示占位)。
 * 格式由 apps/app/plugins/native-guards.test.ts 对着库源码钉住;base64 解码与 Keystore 在安卓专属的 SecureStoreReader 里做。
 */
data class SecureStoreItem(val ct: String, val iv: String, val tlen: Int) {
  companion object {
    const val MIN_TAG_BITS = 96

    fun parse(raw: String?): SecureStoreItem? = try {
      val o = JSONObject(raw ?: "")
      val ct = o.opt("ct") as? String
      val iv = o.opt("iv") as? String
      val tlen = o.opt("tlen") as? Int
      when {
        o.opt("scheme") != "aes" -> null
        o.opt("usesKeystoreSuffix") != true -> null
        o.optBoolean("requireAuthentication", false) -> null
        ct == null || iv == null || tlen == null || tlen < MIN_TAG_BITS -> null
        else -> SecureStoreItem(ct, iv, tlen)
      }
    } catch (e: Exception) {
      null
    }
  }
}
