import CryptoKit
import XCTest
@testable import PushCore

/// 与 Kotlin 端(apps/app/native/android-push VectorTest)对齐的边界用例。
final class ParityTests: XCTestCase {
  func sealWith(_ key: Data, _ plain: String) throws -> [String: Any] {
    let iv = Data((0..<12).map { UInt8($0) })
    let box = try AES.GCM.seal(Data(plain.utf8), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: iv))
    return ["v": 1, "iv": Base64URL.encode(iv), "ct": Base64URL.encode(box.ciphertext + box.tag)]
  }

  /// 钥匙必须正好 32 字节:16 字节(AES-128 合法)封好的包也按认证失败处理。
  func testKeyMustBe32Bytes() throws {
    let short = Data(repeating: 7, count: 16)
    let sealed = try sealWith(short, "{\"ts\":1000,\"kind\":\"test\",\"title\":\"t\",\"body\":\"b\"}")
    XCTAssertEqual(failure(PushCrypto.open(key: short, sealed: sealed, nowMs: 1000)), .auth)
    XCTAssertEqual(failure(PushCrypto.open(key: Data(), sealed: sealed, nowMs: 1000)), .auth)
    // 形状错仍先报 malformed(拒绝顺序:形状 → base64 → 钥匙长度 / 认证)。
    XCTAssertEqual(failure(PushCrypto.open(key: short, sealed: ["v": 2, "iv": "AAECAwQFBgcICQoL", "ct": "AAAA"] as [String: Any], nowMs: 0)), .malformed)
  }

  /// 去重键不能在非有限 / 超出 Int64 的 ts 上崩(Int64(Double) 会 trap):NaN ⇒ 0,其余饱和。
  func testDedupeKeyNeverTrapsOnOddTs() {
    let h = ":ba7816bf8f01cfea414140de5dae2223"
    XCTAssertEqual(PushDedupe.key(ts: .nan, ct: "abc"), "0" + h)
    XCTAssertEqual(PushDedupe.key(ts: .infinity, ct: "abc"), "\(Int64.max)" + h)
    XCTAssertEqual(PushDedupe.key(ts: 1e300, ct: "abc"), "\(Int64.max)" + h)
    XCTAssertEqual(PushDedupe.key(ts: 9.223372036854775807e18, ct: "abc"), "\(Int64.max)" + h)
    XCTAssertEqual(PushDedupe.key(ts: -.infinity, ct: "abc"), "\(Int64.min)" + h)
    XCTAssertEqual(PushDedupe.key(ts: -1e300, ct: "abc"), "\(Int64.min)" + h)
    XCTAssertEqual(PushDedupe.key(ts: -0.0, ct: "abc"), "0" + h)
    XCTAssertEqual(PushDedupe.key(ts: -0.5, ct: "abc"), "-1" + h)
    XCTAssertEqual(PushDedupe.key(ts: 1_700_000_000_123.9, ct: "abc"), "1700000000123" + h)
  }

  func evictionSurvivor(_ a: String, _ b: String) -> String? {
    var initial: [String: Int64] = [:]
    for i in 0..<(PushDedupe.capacity - 2) { initial[String(format: "k%03d", i)] = 100 }
    initial[a] = 1; initial[b] = 1
    var store = PushDedupe(entries: initial)
    XCTAssertFalse(store.seen("new", nowMs: 100))
    XCTAssertEqual(store.entries.count, PushDedupe.capacity)
    let left = [a, b].filter { store.entries[$0] != nil }
    XCTAssertEqual(left.count, 1)
    return left.first
  }

  /// 同刻平局按码点升序先删(向量 rules)。Kotlin 那对:U+FFFF < U+1F600。
  func testTieBreakByCodePointKotlinPair() {
    XCTAssertEqual(evictionSurvivor("\u{FFFF}", "\u{1F600}"), "\u{1F600}")
    XCTAssertEqual(evictionSurvivor("\u{1F600}", "\u{FFFF}"), "\u{1F600}")
  }

  /// Swift 的 String < 按 NFC 规范化后比:U+212B(埃符号)规范化成 U+00C5 < U+00C6;按码点则 U+00C6 < U+212B,应先删 U+00C6。
  func testTieBreakByCodePointNotSwiftStringOrder() {
    XCTAssertTrue("\u{212B}" < "\u{C6}", "前提:Swift 默认序与码点序在这对上相反")
    XCTAssertEqual(evictionSurvivor("\u{212B}", "\u{C6}"), "\u{212B}")
    XCTAssertEqual(evictionSurvivor("\u{C6}", "\u{212B}"), "\u{212B}")
  }
}
