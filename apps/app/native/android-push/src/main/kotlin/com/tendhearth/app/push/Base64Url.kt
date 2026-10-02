package com.tendhearth.app.push

import java.io.ByteArrayOutputStream

/** 与 packages/protocol/src/b64u.ts 同一规则:容忍尾部 `=`;长度模 4 余 1 或有非法字符 ⇒ null。不用 java.util.Base64(安卓 26 以下没有)。 */
object Base64Url {
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  fun decode(s: String): ByteArray? {
    val clean = s.trimEnd('=')
    if (clean.length % 4 == 1) return null
    val out = ByteArrayOutputStream(clean.length * 3 / 4)
    var buffer = 0
    var bits = 0
    for (ch in clean) {
      val v = ALPHABET.indexOf(ch)
      if (v < 0) return null
      buffer = (buffer shl 6) or v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((buffer shr bits) and 0xff)
      }
    }
    return out.toByteArray()
  }
}
