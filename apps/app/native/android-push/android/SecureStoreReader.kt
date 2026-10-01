package com.tendhearth.app.push

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * 读 app 经 expo-secure-store(57.x)写下的推送密钥记录(src/push/key-store.ts)。消息服务与 app 同一进程、同一 UID,
 * 能读同一份 SharedPreferences 与 AndroidKeyStore。记录形状在核心的 SecureStoreItem 里校验(JVM 单测);
 * 格式由 apps/app/plugins/native-guards.test.ts 对着库源码钉住。读不出 ⇒ null(消息服务显示占位)。不打日志。
 */
object SecureStoreReader {
  private const val PREFS = "SecureStore"
  private const val SERVICE = "tendhearth.push"
  private const val ITEM = "tendhearth.pushkey.v1"
  private const val ALIAS = "AES/GCM/NoPadding:$SERVICE:keystoreUnauthenticated"

  fun readPushKeyRecord(ctx: Context): String? = try {
    val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("$SERVICE-$ITEM", null)
    val item = SecureStoreItem.parse(raw)
    if (item == null) null else {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
      if (key == null) null else {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(item.tlen, Base64.decode(item.iv, Base64.DEFAULT)))
        String(c.doFinal(Base64.decode(item.ct, Base64.DEFAULT)), Charsets.UTF_8)
      }
    }
  } catch (e: Exception) {
    null
  }
}
