import XCTest
@testable import PushCore

/// 仓库根:本文件在 apps/app/native/ios-notify/Tests/PushCoreTests/ 下,往上 7 层。
let repoRoot: URL = {
  var u = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { u = u.deletingLastPathComponent() }
  return u
}()

func loadJSON(_ rel: String) throws -> [String: Any] {
  let d = try Data(contentsOf: repoRoot.appendingPathComponent(rel))
  return try XCTUnwrap(JSONSerialization.jsonObject(with: d) as? [String: Any])
}

func failure<T>(_ r: Result<T, PushOpenError>) -> PushOpenError? {
  if case .failure(let e) = r { return e }
  return nil
}

final class VectorTests: XCTestCase {
  func testDeriveKeyMatchesRegressionVector() throws {
    let v = try loadJSON("packages/protocol/vectors/push.json")
    let key = PushCrypto.deriveKey(deviceToken: v["deviceToken"] as! String)
    XCTAssertEqual(Base64URL.encode(key), v["key"] as? String)
  }

  func testEveryCase() throws {
    let v = try loadJSON("packages/protocol/vectors/push.json")
    let token = v["deviceToken"] as! String
    let key = PushCrypto.deriveKey(deviceToken: token)
    let wrong = PushCrypto.deriveKey(deviceToken: token + "x")
    let cases = try XCTUnwrap(v["cases"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 8)
    for c in cases {
      let name = c["name"] as! String
      let now = (c["now"] as! NSNumber).int64Value
      let k = (c["wrongKey"] as? Bool) == true ? wrong : key
      let r = PushCrypto.open(key: k, sealed: c["sealed"], nowMs: now)
      switch c["expect"] as! String {
      case "ok":
        guard case .success(let o) = r else { XCTFail("\(name): \(r)"); continue }
        let got = try XCTUnwrap(PushMessage.parse(o.payload), name)
        let want = try XCTUnwrap(PushMessage.parse(c["payload"] as! [String: Any]), name)
        XCTAssertEqual(got, want, name)
        XCTAssertEqual(PushDedupe.key(ts: got.ts, ct: o.ct), c["dedupeKey"] as? String, name)
      case "invalid":
        guard case .success(let o) = r else { XCTFail("\(name): \(r)"); continue }
        XCTAssertNil(PushMessage.parse(o.payload), name)
      case "stale": XCTAssertEqual(failure(r), .stale, name)
      case "auth": XCTAssertEqual(failure(r), .auth, name)
      case "malformed": XCTAssertEqual(failure(r), .malformed, name)
      default: XCTFail("unknown expect in \(name)")
      }
    }
  }

  func testDedupeSteps() throws {
    let v = try loadJSON("packages/protocol/vectors/push.json")
    let d = try XCTUnwrap(v["dedupe"] as? [String: Any])
    XCTAssertEqual((d["capacity"] as! NSNumber).intValue, PushDedupe.capacity)
    XCTAssertEqual((d["ttlMs"] as! NSNumber).int64Value, PushDedupe.ttlMs)
    var store = PushDedupe()
    for s in d["steps"] as! [[String: Any]] {
      let dup = store.seen(s["key"] as! String, nowMs: (s["now"] as! NSNumber).int64Value)
      XCTAssertEqual(dup ? "duplicate" : "new", s["expect"] as? String, s["note"] as? String ?? "")
    }
  }

  func testDedupeEvictsOldestWhenFull() {
    var store = PushDedupe()
    for i in 0..<PushDedupe.capacity { _ = store.seen(String(format: "k%03d", i), nowMs: Int64(1000 + i)) }
    XCTAssertFalse(store.seen("new", nowMs: 5000))
    XCTAssertEqual(store.entries.count, PushDedupe.capacity)
    XCTAssertNil(store.entries["k000"])
    XCTAssertTrue(store.seen("k001", nowMs: 5001))
  }

  func testMalformedShapes() {
    let key = PushCrypto.deriveKey(deviceToken: "t")
    XCTAssertEqual(failure(PushCrypto.open(key: key, sealed: nil, nowMs: 0)), .malformed)
    XCTAssertEqual(failure(PushCrypto.open(key: key, sealed: "nope", nowMs: 0)), .malformed)
    XCTAssertEqual(failure(PushCrypto.open(key: key, sealed: ["v": true, "iv": "AAECAwQFBgcICQoL", "ct": "AAAA"] as [String: Any], nowMs: 0)), .malformed)
    XCTAssertEqual(failure(PushCrypto.open(key: key, sealed: ["v": 1, "iv": "!!", "ct": "AAAA"] as [String: Any], nowMs: 0)), .malformed)
    XCTAssertEqual(failure(PushCrypto.open(key: key, sealed: ["v": 1, "iv": "AAECAwQFBgcICQoL", "ct": "AAAA"] as [String: Any], nowMs: 0)), .malformed) // ct 不足 16 字节
  }
}
