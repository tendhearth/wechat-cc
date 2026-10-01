import Foundation

/// 与 packages/protocol/src/b64u.ts 同一规则:编码不带填充;解码容忍尾部 `=`,长度模 4 余 1 或有非法字符 ⇒ nil。
public enum Base64URL {
  static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
  static let table: [UInt8: UInt32] = {
    var t: [UInt8: UInt32] = [:]
    for (i, c) in alphabet.enumerated() { t[c] = UInt32(i) }
    return t
  }()

  public static func decode(_ s: String) -> Data? {
    var chars = Array(s.utf8)
    while chars.last == UInt8(ascii: "=") { chars.removeLast() }
    if chars.count % 4 == 1 { return nil }
    var out = Data(capacity: chars.count * 3 / 4)
    var buffer: UInt32 = 0
    var bits = 0
    for c in chars {
      guard let v = table[c] else { return nil }
      buffer = (buffer << 6) | v
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((buffer >> UInt32(bits)) & 0xff))
      }
    }
    return out
  }

  public static func encode(_ d: Data) -> String {
    d.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
