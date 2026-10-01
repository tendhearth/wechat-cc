import Foundation

/// 解开之后的明文,与 packages/protocol 的 PushPlaintext(zod)同一形状:多余字段忽略;可选字段出现就必须是字符串(null 也拒)。
public struct PushMessage: Equatable {
  public enum Kind: String { case permission, question, task_done, task_failed, test }
  public let ts: Double
  public let kind: Kind
  public let title: String
  public let body: String
  public let taskId: String?
  public let requestId: String?

  public init(ts: Double, kind: Kind, title: String, body: String, taskId: String?, requestId: String?) {
    self.ts = ts; self.kind = kind; self.title = title; self.body = body; self.taskId = taskId; self.requestId = requestId
  }

  public static func parse(_ d: [String: Any]) -> PushMessage? {
    guard let ts = PushCrypto.number(d["ts"])?.doubleValue,
          let k = d["kind"] as? String, let kind = Kind(rawValue: k),
          let title = d["title"] as? String, let body = d["body"] as? String else { return nil }
    if d["taskId"] != nil && !(d["taskId"] is String) { return nil }
    if d["requestId"] != nil && !(d["requestId"] is String) { return nil }
    return PushMessage(ts: ts, kind: kind, title: title, body: body, taskId: d["taskId"] as? String, requestId: d["requestId"] as? String)
  }

  /// iOS 通知的 category(app 里注册,不带任何动作:通知本身从不执行操作)。
  public var category: String {
    switch kind {
    case .permission: return "th.approval"
    case .question: return "th.question"
    case .task_done: return "th.done"
    case .task_failed: return "th.failed"
    case .test: return "th.test"
    }
  }
}
