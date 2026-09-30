import CryptoKit
import Foundation

public enum PushOpenError: Error, Equatable { case malformed, auth, stale }

public struct OpenedPush {
  public let payload: [String: Any]
  /// 线上的 ct 原文(base64url),去重键用它。
  public let ct: String
}

/// 与 packages/protocol/src/push.ts 的 derivePushKey / openPush 同一算法、同一拒绝顺序:
/// 形状 → base64 → GCM 认证 → 明文是 JSON 对象 → ts 是有限数字 → 时间窗(过去 1 小时 / 未来 10 分钟)。
public enum PushCrypto {
  public static let maxAgeMs: Int64 = 3_600_000
  public static let maxSkewMs: Int64 = 600_000
  static let info = Data("wechat-cc/push/v1".utf8)

  /// HKDF-SHA256(ikm = utf8(deviceToken), salt = 空, info = "wechat-cc/push/v1") → 32 字节。
  /// 扩展本身不调用(钥匙串里存的就是推好的密钥),给测试向量核对用。
  public static func deriveKey(deviceToken: String) -> Data {
    let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: Data(deviceToken.utf8)), salt: Data(), info: info, outputByteCount: 32)
    return k.withUnsafeBytes { Data($0) }
  }

  /// JSON 数字(排除 true / false:它们在 Foundation 里也是 NSNumber)。
  public static func number(_ x: Any?) -> NSNumber? {
    guard let n = x as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n
  }

  public static func open(key: Data, sealed: Any?, nowMs: Int64) -> Result<OpenedPush, PushOpenError> {
    guard let s = sealed as? [String: Any] else { return .failure(.malformed) }
    guard let v = number(s["v"]), v.doubleValue == 1 else { return .failure(.malformed) }
    guard let ivS = s["iv"] as? String, let ctS = s["ct"] as? String,
          let iv = Base64URL.decode(ivS), let ct = Base64URL.decode(ctS),
          iv.count == 12, ct.count >= 16,
          let nonce = try? AES.GCM.Nonce(data: iv) else { return .failure(.malformed) }
    let plain: Data
    do {
      let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
      plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
    } catch {
      return .failure(.auth)
    }
    guard let obj = try? JSONSerialization.jsonObject(with: plain), let dict = obj as? [String: Any] else { return .failure(.malformed) }
    guard let tsN = number(dict["ts"]), tsN.doubleValue.isFinite else { return .failure(.malformed) }
    let ts = tsN.doubleValue
    if ts < Double(nowMs - maxAgeMs) || ts > Double(nowMs + maxSkewMs) { return .failure(.stale) }
    return .success(OpenedPush(payload: dict, ct: ctS))
  }
}
