import Foundation

public struct PushDisplay: Equatable {
  public let title: String
  public let body: String
  public let category: String?
  public let thread: String?
  /// 放进 userInfo["tendhearth"]:app 点通知时按它路由(src/push/target.ts)。
  public let route: [String: String]?
}

public enum PushPresenter {
  public typealias Strings = [String: [String: String]]

  /// 钥匙串记录里的语言(设置里手动选的)优先;否则跟系统:第一个首选语言以 zh 开头 ⇒ zh-Hans,其余 en(同 src/i18n pickLang)。
  public static func lang(record: String?, preferred: [String]) -> String {
    if let r = record, r == "en" || r == "zh-Hans" { return r }
    return (preferred.first?.lowercased().hasPrefix("zh") ?? false) ? "zh-Hans" : "en"
  }

  static func s(_ strings: Strings, _ lang: String, _ key: String) -> String {
    strings[lang]?[key] ?? strings["en"]?[key] ?? key
  }

  public static func placeholder(lang: String, strings: Strings) -> PushDisplay {
    PushDisplay(title: s(strings, lang, "placeholder.title"), body: s(strings, lang, "placeholder.body"), category: nil, thread: nil, route: nil)
  }

  /// 标题按 kind 本地化(不用 daemon 写死的中文标题,见计划裁决 2);正文是用户自己的数据(任务名 / 请求摘要)原样显示;test 的正文也本地化。
  public static func display(_ m: PushMessage, lang: String, strings: Strings) -> PushDisplay {
    var route = ["kind": m.kind.rawValue]
    if let t = m.taskId { route["taskId"] = t }
    if let r = m.requestId { route["requestId"] = r }
    let body = m.kind == .test ? s(strings, lang, "body.test") : m.body
    return PushDisplay(title: s(strings, lang, "title.\(m.kind.rawValue)"), body: body, category: m.category, thread: m.taskId ?? m.kind.rawValue, route: route)
  }
}
