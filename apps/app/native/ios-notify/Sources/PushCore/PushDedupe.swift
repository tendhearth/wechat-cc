import CryptoKit
import Foundation

/// 与 packages/protocol 的 pushDedupeKey / makePushDedupe 同一规则(向量 dedupe.steps 钉住)。
public struct PushDedupe {
  public static let capacity = 64
  public static let ttlMs: Int64 = PushCrypto.maxAgeMs + PushCrypto.maxSkewMs
  public private(set) var entries: [String: Int64]

  public init(entries: [String: Int64] = [:]) { self.entries = entries }

  /// 调用方在 open 成功之后算(那时 ts 已是窗口内的有限数字);即便传进 NaN / ±∞ / 超出 Int64 的值也不 trap:
  /// NaN ⇒ 0,其余饱和到 Int64 的上下限(与 Kotlin 的 Double.toLong 同义)。
  public static func key(ts: Double, ct: String) -> String {
    let hex = SHA256.hash(data: Data(ct.utf8)).map { String(format: "%02x", $0) }.joined()
    return "\(floorToInt64(ts)):\(hex.prefix(32))"
  }

  static func floorToInt64(_ ts: Double) -> Int64 {
    if ts.isNaN { return 0 }
    let f = ts.rounded(.down)
    // Double(Int64.max) 是 2^63(超出范围),所以用 >= 判上限;Double(Int64.min) = -2^63 正好可表示。
    if f >= Double(Int64.max) { return .max }
    if f <= Double(Int64.min) { return .min }
    return Int64(f)
  }

  /// 按 Unicode 码点逐个比(向量 rules);Swift 的 String < 比的是 NFC 规范化后的结果,会排错。
  static func codePointLess(_ a: String, _ b: String) -> Bool {
    a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars) { $0.value < $1.value }
  }

  /// 记下时刻升序删,平局按键名码点升序。
  /// true = 见过(重复);false = 新的,已记下。
  public mutating func seen(_ key: String, nowMs: Int64) -> Bool {
    entries = entries.filter { nowMs - $0.value <= Self.ttlMs }
    if entries[key] != nil { return true }
    entries[key] = nowMs
    while entries.count > Self.capacity {
      guard let oldest = entries.min(by: { $0.value < $1.value || ($0.value == $1.value && Self.codePointLess($0.key, $1.key)) }) else { break }
      entries.removeValue(forKey: oldest.key)
    }
    return false
  }
}
