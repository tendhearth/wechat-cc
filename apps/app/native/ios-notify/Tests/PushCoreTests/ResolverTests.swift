import XCTest
@testable import PushCore

/// 扩展的整条决定(NotificationService 只负责钥匙串、去重存储与交付):
/// 任何一步不成立 ⇒ 中性占位,从不显示载荷里的原始标题 / 正文;去重键只在解开且合形状之后才算。
final class ResolverTests: XCTestCase {
  var v: [String: Any] = [:]
  var s: PushPresenter.Strings = [:]
  override func setUpWithError() throws {
    v = try loadJSON("packages/protocol/vectors/push.json")
    s = try loadJSON("apps/app/native/push-strings.json").mapValues { $0 as! [String: String] }
  }
  func vcase(_ name: String) -> [String: Any] { (v["cases"] as! [[String: Any]]).first { $0["name"] as? String == name }! }
  func record(lang: String? = "en", token: String? = nil) -> PushKeyRecord {
    PushKeyRecord(key: PushCrypto.deriveKey(deviceToken: token ?? v["deviceToken"] as! String), lang: lang)
  }
  func resolve(_ c: [String: Any], record: PushKeyRecord?, preferred: [String] = ["en-US"], seen: @escaping (String) -> Bool = { _ in false }) -> (PushResolution, [String]) {
    var asked: [String] = []
    let r = PushResolver.resolve(record: record, sealed: c["sealed"], preferred: preferred, nowMs: (c["now"] as! NSNumber).int64Value, strings: s) { k in asked.append(k); return seen(k) }
    return (r, asked)
  }

  func testOkShowsLocalisedDisplayAndAsksDedupeWithVectorKey() {
    let c = vcase("ok")
    let (r, asked) = resolve(c, record: record())
    let m = PushMessage.parse(c["payload"] as! [String: Any])!
    XCTAssertEqual(r.display, PushPresenter.display(m, lang: "en", strings: s))
    XCTAssertFalse(r.duplicate)
    XCTAssertEqual(asked, [c["dedupeKey"] as! String])
  }

  func testDuplicateIsFlaggedButStillDisplayed() {
    let c = vcase("ok")
    let (r, _) = resolve(c, record: record(), seen: { _ in true })
    XCTAssertTrue(r.duplicate)
    XCTAssertEqual(r.display.category, "th.approval")
  }

  func testRecordLangWinsThenSystem() {
    let c = vcase("ok")
    XCTAssertEqual(resolve(c, record: record(lang: "zh-Hans")).0.display.title, "需要你批准")
    XCTAssertEqual(resolve(c, record: record(lang: nil), preferred: ["zh-Hans-CN"]).0.display.title, "需要你批准")
    XCTAssertEqual(resolve(vcase("auth-wrong-key"), record: nil, preferred: ["zh-Hans-CN"]).0.display.body, "CC 有新动态")
  }

  func testEveryFailureIsThePlaceholderAndNeverTouchesDedupe() {
    let placeholder = PushPresenter.placeholder(lang: "en", strings: s)
    let failures: [(String, PushKeyRecord?)] = [
      ("ok", nil),                                               // 没有密钥记录
      ("ok", record(token: "someone-else")),                    // 错钥
      ("auth-tampered", record()),
      ("stale-past-61min", record()),
      ("stale-future-11min", record()),
      ("malformed-v2", record()),
      ("invalid-kind", record()),                                // 解开了,但明文不合 PushPlaintext
    ]
    for (name, rec) in failures {
      let (r, asked) = resolve(vcase(name), record: rec)
      XCTAssertEqual(r.display, placeholder, name)
      XCTAssertFalse(r.duplicate, name)
      XCTAssertEqual(asked, [], name)
    }
    // 载荷里根本没有 wcc / wcc 形状不对
    XCTAssertEqual(PushResolver.resolve(record: record(), sealed: nil, preferred: [], nowMs: 0, strings: s) { _ in XCTFail(); return false }.display, placeholder)
    XCTAssertEqual(PushResolver.resolve(record: record(), sealed: "x", preferred: [], nowMs: 0, strings: s) { _ in XCTFail(); return false }.display, placeholder)
  }

  func testPlaceholderResolutionMatchesTimeoutPath() {
    XCTAssertEqual(PushResolver.placeholder(record: record(lang: "zh-Hans"), preferred: ["en"], strings: s),
                   PushResolution(display: PushPresenter.placeholder(lang: "zh-Hans", strings: s), duplicate: false))
  }
}
