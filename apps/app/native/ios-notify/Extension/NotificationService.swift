import Foundation
import UserNotifications

/// 通知服务扩展(spec §7):中继发来的是占位 alert + mutable-content + `wcc` 密文。
/// 决定全在 PushResolver(纯逻辑,swift test 覆盖):解开且合形状 ⇒ 按 kind 换标题、正文、category、线程、路由;
/// 任何一步失败 ⇒ 本地化的中性占位。系统催超时 ⇒ 交出中性占位(不交半成品,也不交载荷原文)。
/// 从不记录明文、密钥或密文。
final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let record = PushKeyStore.load()
    let preferred = Locale.preferredLanguages
    let placeholder = content(from: request, PushResolver.placeholder(record: record, preferred: preferred, strings: PushStrings.table))
    lock.lock(); handler = contentHandler; fallback = placeholder; lock.unlock()

    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    let r = PushResolver.resolve(record: record, sealed: request.content.userInfo["wcc"], preferred: preferred, nowMs: nowMs,
                                 strings: PushStrings.table) { DedupeStore.seen($0, nowMs: nowMs) }
    deliver(content(from: request, r))
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock(); let c = fallback; lock.unlock()
    if let c { deliver(c) }
  }

  private func content(from request: UNNotificationRequest, _ r: PushResolution) -> UNNotificationContent {
    let c = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    let d = r.display
    c.title = d.title
    c.subtitle = ""
    c.body = d.body
    c.categoryIdentifier = d.category ?? ""
    c.threadIdentifier = d.thread ?? ""
    var info = c.userInfo
    info.removeValue(forKey: "tendhearth")
    if let route = d.route { info["tendhearth"] = route }
    c.userInfo = info
    // iOS 不能丢掉一条推送(除非有 Apple 特批的过滤权限):重复的那条改成不响不亮(计划裁决 3)。
    if r.duplicate {
      c.sound = nil
      c.interruptionLevel = .passive
    }
    return c
  }

  /// 只交一次:didReceive 与超时回调可能在不同线程上赛跑。
  private func deliver(_ c: UNNotificationContent) {
    lock.lock()
    let h = handler
    handler = nil
    lock.unlock()
    h?(c)
  }
}
