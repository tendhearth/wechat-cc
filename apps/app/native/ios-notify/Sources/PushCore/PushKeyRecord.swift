import Foundation

/// app 写进共享钥匙串的推送密钥记录:{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}(src/push/key-store.ts)。
public struct PushKeyRecord {
  public let key: Data
  public let lang: String?

  public static func parse(_ s: String) -> PushKeyRecord? {
    guard let d = s.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let v = PushCrypto.number(o["v"]), v.doubleValue == 1,
          let k = o["key"] as? String, let key = Base64URL.decode(k), key.count == 32 else { return nil }
    let lang = o["lang"] as? String
    return PushKeyRecord(key: key, lang: (lang == "en" || lang == "zh-Hans") ? lang : nil)
  }
}
