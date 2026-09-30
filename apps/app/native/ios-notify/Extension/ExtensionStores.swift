import Foundation
import Security

/// 读 app 经 expo-secure-store 写进共享钥匙串的推送密钥记录(src/push/key-store.ts)。
/// expo-secure-store 的查询形状:service = "<keychainService>:no-auth",account = 键名的 UTF-8(plugins/native-guards.test.ts 钉住)。
/// 不指定 access group:扩展只有共享组这一个组,查询自然落在那里。
/// 读不到 / 不合法 ⇒ nil(调用方显示中性占位);状态码与内容都不记日志。
enum PushKeyStore {
  static func load() -> PushKeyRecord? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "tendhearth.push:no-auth",
      kSecAttrAccount as String: Data("tendhearth.pushkey.v1".utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
    return PushKeyRecord.parse(s)
  }
}

/// 去重记录放在扩展自己容器的 UserDefaults(不需要 App Group:只有扩展读写它)。只存去重键(时间 + 密文哈希前缀)。
enum DedupeStore {
  static let key = "tendhearth.push.dedupe"
  static func seen(_ k: String, nowMs: Int64) -> Bool {
    let d = UserDefaults.standard
    let raw = d.dictionary(forKey: key) as? [String: NSNumber] ?? [:]
    var store = PushDedupe(entries: raw.mapValues { $0.int64Value })
    let dup = store.seen(k, nowMs: nowMs)
    d.set(store.entries.mapValues { NSNumber(value: $0) }, forKey: key)
    return dup
  }
}
