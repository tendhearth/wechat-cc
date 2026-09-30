package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** expo-secure-store 57.x 在 SharedPreferences 里写的记录形状(apps/app/plugins/native-guards.test.ts 钉住库源码)。 */
class SecureStoreItemTest {
  // 形状照 SecureStoreModule.setItemImpl + saveEncryptedItem:ct / iv / tlen / scheme / usesKeystoreSuffix / keystoreAlias / requireAuthentication
  private fun written() = JSONObject()
    .put("ct", "Y3Q=").put("iv", "aXY=").put("tlen", 128)
    .put("scheme", "aes").put("usesKeystoreSuffix", true).put("keystoreAlias", "tendhearth.push").put("requireAuthentication", false)

  @Test fun parsesWhatSecureStoreWrites() {
    assertEquals(SecureStoreItem("Y3Q=", "aXY=", 128), SecureStoreItem.parse(written().toString()))
  }

  @Test fun rejectsWhatWeCannotOrMustNotRead() {
    assertNull(SecureStoreItem.parse(null))
    assertNull(SecureStoreItem.parse("not json"))
    assertNull(SecureStoreItem.parse(written().put("scheme", "hybrid").toString()))          // 安卓 23 以下的 RSA 混合方案
    assertNull(SecureStoreItem.parse(written().apply { remove("scheme") }.toString()))
    assertNull(SecureStoreItem.parse(written().put("usesKeystoreSuffix", false).toString()))  // 旧格式:别名不带后缀
    assertNull(SecureStoreItem.parse(written().apply { remove("usesKeystoreSuffix") }.toString()))
    assertNull(SecureStoreItem.parse(written().put("requireAuthentication", true).toString())) // 要生物识别:后台读不了
    assertNull(SecureStoreItem.parse(written().put("tlen", 64).toString()))                    // 库自己也拒 < 96
    assertNull(SecureStoreItem.parse(written().put("tlen", "128").toString()))
    assertNull(SecureStoreItem.parse(written().apply { remove("ct") }.toString()))
    assertNull(SecureStoreItem.parse(written().put("iv", 5).toString()))
  }
}
