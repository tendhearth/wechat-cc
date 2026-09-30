import CryptoKit
import Foundation

/// 与 packages/protocol 的 pushDedupeKey / makePushDedupe 同一规则(向量 dedupe.steps 钉住)。
public struct PushDedupe {
  public static let capacity = 64
  public static let ttlMs: Int64 = PushCrypto.maxAgeMs + PushCrypto.maxSkewMs
  public private(set) var entries: [String: Int64]

  public init(entries: [String: Int64] = [:]) { self.entries = entries }

  public static func key(ts: Double, ct: String) -> String {
    let hex = SHA256.hash(data: Data(ct.utf8)).map { String(format: "%02x", $0) }.joined()
    return "\(Int64(ts.rounded(.down))):\(hex.prefix(32))"
  }

  /// true = 见过(重复);false = 新的,已记下。
  public mutating func seen(_ key: String, nowMs: Int64) -> Bool {
    entries = entries.filter { nowMs - $0.value <= Self.ttlMs }
    if entries[key] != nil { return true }
    entries[key] = nowMs
    while entries.count > Self.capacity {
      guard let oldest = entries.min(by: { $0.value < $1.value || ($0.value == $1.value && $0.key < $1.key) }) else { break }
      entries.removeValue(forKey: oldest.key)
    }
    return false
  }
}
