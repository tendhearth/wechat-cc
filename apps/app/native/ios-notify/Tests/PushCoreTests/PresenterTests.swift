import XCTest
@testable import PushCore

final class PresenterTests: XCTestCase {
  func strings() throws -> PushPresenter.Strings {
    let raw = try loadJSON("apps/app/native/push-strings.json")
    return raw.mapValues { $0 as! [String: String] }
  }
  func okMessage() throws -> PushMessage {
    let v = try loadJSON("packages/protocol/vectors/push.json")
    let ok = (v["cases"] as! [[String: Any]]).first { $0["name"] as? String == "ok" }!
    return try XCTUnwrap(PushMessage.parse(ok["payload"] as! [String: Any]))
  }

  func testBothLanguagesHaveTheSameKeys() throws {
    let s = try strings()
    XCTAssertEqual(Set(s["en"]!.keys), Set(s["zh-Hans"]!.keys))
  }

  func testPermissionIsLocalisedByKindAndBodyPassesThrough() throws {
    let s = try strings()
    let m = try okMessage()
    let zh = PushPresenter.display(m, lang: "zh-Hans", strings: s)
    XCTAssertEqual(zh.title, "需要你批准")
    XCTAssertEqual(zh.body, m.body)
    XCTAssertEqual(zh.category, "th.approval")
    XCTAssertEqual(zh.thread, "t-42")
    XCTAssertEqual(zh.route, ["kind": "permission", "taskId": "t-42", "requestId": "r-7"])
    XCTAssertEqual(PushPresenter.display(m, lang: "en", strings: s).title, "Needs your approval")
  }

  func testTestKindUsesLocalisedBodyAndPlaceholderIsNeutral() throws {
    let s = try strings()
    let t = PushMessage(ts: 1, kind: .test, title: "CC", body: "这是一条测试通知", taskId: nil, requestId: nil)
    XCTAssertEqual(PushPresenter.display(t, lang: "en", strings: s).body, "Notifications reach this phone.")
    XCTAssertEqual(PushPresenter.display(t, lang: "en", strings: s).thread, "test")
    let p = PushPresenter.placeholder(lang: "en", strings: s)
    XCTAssertEqual(p, PushDisplay(title: "CC", body: "CC has news", category: nil, thread: nil, route: nil))
  }

  func testLanguagePick() {
    XCTAssertEqual(PushPresenter.lang(record: "zh-Hans", preferred: ["en-GB"]), "zh-Hans")
    XCTAssertEqual(PushPresenter.lang(record: nil, preferred: ["zh-Hant-TW", "en"]), "zh-Hans")
    XCTAssertEqual(PushPresenter.lang(record: nil, preferred: ["en-GB", "zh-Hans"]), "en")
    XCTAssertEqual(PushPresenter.lang(record: "fr", preferred: []), "en")
  }

  func testCategoriesPerKind() {
    let k: [PushMessage.Kind: String] = [.permission: "th.approval", .question: "th.question", .task_done: "th.done", .task_failed: "th.failed", .test: "th.test"]
    for (kind, cat) in k { XCTAssertEqual(PushMessage(ts: 1, kind: kind, title: "", body: "", taskId: nil, requestId: nil).category, cat) }
  }

  func testMessageParseMatchesZodShape() {
    XCTAssertNil(PushMessage.parse(["ts": 1, "kind": "test", "title": "t"]))                              // 缺 body
    XCTAssertNil(PushMessage.parse(["ts": 1, "kind": "approval_needed", "title": "t", "body": "b"]))      // 未知 kind
    XCTAssertNil(PushMessage.parse(["ts": "x", "kind": "test", "title": "t", "body": "b"]))               // ts 非数字
    XCTAssertNil(PushMessage.parse(["ts": 1, "kind": "test", "title": "t", "body": "b", "taskId": NSNull()]))
    XCTAssertNotNil(PushMessage.parse(["ts": 1, "kind": "test", "title": "t", "body": "b", "extra": 1]))
  }

  func testKeyRecord() throws {
    let v = try loadJSON("packages/protocol/vectors/push.json")
    let rec = try XCTUnwrap(PushKeyRecord.parse("{\"v\":1,\"key\":\"\(v["key"] as! String)\",\"lang\":\"zh-Hans\"}"))
    XCTAssertEqual(rec.key, PushCrypto.deriveKey(deviceToken: v["deviceToken"] as! String))
    XCTAssertEqual(rec.lang, "zh-Hans")
    XCTAssertNil(PushKeyRecord.parse("{\"v\":1,\"key\":\"AAAA\",\"lang\":null}"))   // 不是 32 字节
    XCTAssertNil(PushKeyRecord.parse("{\"v\":2,\"key\":\"\(v["key"] as! String)\"}"))
    XCTAssertNil(PushKeyRecord.parse("not json"))
    XCTAssertNil(try XCTUnwrap(PushKeyRecord.parse("{\"v\":1,\"key\":\"\(v["key"] as! String)\",\"lang\":\"fr\"}")).lang)
  }
}
