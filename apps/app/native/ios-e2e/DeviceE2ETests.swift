// 真机验收的 UI 步骤(scripts/device-e2e.ts 逐步调用:xcodebuild test-without-building -only-testing:TendhearthUITests/DeviceE2ETests/<步骤>)。
// 每一步都**接管已经在跑的 app**(XCUIApplication(bundleIdentifier:).activate(),不重装、不冷启动),编排脚本在步骤之间做 daemon 那头的事。
// 参数走环境变量:xcodebuild 把 TEST_RUNNER_<名字> 去掉前缀交给测试进程。输出用一行一条的 `E2E_OUT 键=值`,编排脚本从 xcodebuild 输出里捞。
// 只认 testID(accessibilityIdentifier)与中英两份文案,不依赖系统语言。系统弹窗(通知权限、「在 Tendhearth 中打开?」)一律点允许 / 打开。
import XCTest

final class DeviceE2ETests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "com.tendhearth.app")
  private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  private var env: [String: String] { ProcessInfo.processInfo.environment }

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  override func tearDown() {
    // 失败时留一张截图进 xcresult(编排脚本另外用 devicectl 截一张进报告目录)
    if let run = testRun, run.failureCount > 0 {
      let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      shot.name = "failure-\(name)"
      shot.lifetime = .keepAlways
      add(shot)
    }
    super.tearDown()
  }

  // MARK: helpers

  private func param(_ key: String) -> String {
    guard let v = env[key], !v.isEmpty else { XCTFail("missing env \(key)"); return "" }
    return v
  }
  private func timeout(_ key: String, _ def: Double) -> Double { Double(env[key] ?? "") ?? def }
  private func out(_ key: String, _ value: String) {
    print("E2E_OUT \(key)=\(value.replacingOccurrences(of: "\n", with: " "))")
  }
  private func byId(_ id: String, in root: XCUIApplication? = nil) -> XCUIElement {
    (root ?? app).descendants(matching: .any).matching(identifier: id).firstMatch
  }
  private func byIdPrefix(_ prefix: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
  }
  private func labelContains(_ text: String, in root: XCUIApplication? = nil) -> XCUIElement {
    (root ?? app).descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }
  private func anyLabel(_ texts: [String], in root: XCUIApplication? = nil) -> XCUIElement {
    let preds = texts.map { NSPredicate(format: "label CONTAINS %@", $0) }
    return (root ?? app).descendants(matching: .any).matching(NSCompoundPredicate(orPredicateWithSubpredicates: preds)).firstMatch
  }
  /// 轮询直到 cond 为真或超时;每轮顺手收掉系统弹窗。
  @discardableResult
  private func until(_ seconds: Double, _ what: String, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if cond() { return true }
      acceptSystemAlerts()
      Thread.sleep(forTimeInterval: 0.5)
    }
    if cond() { return true }
    XCTFail("timeout after \(Int(seconds))s: \(what)")
    return false
  }
  /// 通知权限框点「允许」、「在 Tendhearth 中打开?」点「打开」。不点「不允许」。
  private func acceptSystemAlerts() {
    let alert = springboard.alerts.firstMatch
    guard alert.exists else { return }
    for title in ["允许", "Allow", "打开", "Open"] {
      let b = alert.buttons[title]
      if b.exists { out("system_alert", "\(alert.label) -> \(title)"); b.tap(); return }
    }
  }
  private func attachScreenshot(_ name: String) {
    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
  private func foreground() {
    app.activate()
    _ = app.wait(for: .runningForeground, timeout: 15)
  }

  // MARK: steps

  /// dev-e2e 页(state/e2e-stash.ts):编排脚本用 devicectl 带 tendhearth://dev-e2e?op=… 启动 app 后调这一步,读出结果。
  func testDevE2EResult() {
    foreground()
    let el = byIdPrefix("dev-e2e-")
    until(timeout("E2E_WAIT", 30), "dev-e2e result") {
      el.exists && el.identifier != "dev-e2e-pending"
    }
    out("dev_e2e", el.identifier.replacingOccurrences(of: "dev-e2e-", with: ""))
  }

  /// a. 配对:确认卡出现,中继主机与核对码与 daemon 铸码时给的一致;点连接 ⇒ 回此刻且顶栏「家里的电脑 · 在线」(= CC 亮)。
  func testPairConfirmAndConnect() {
    let code = param("E2E_CHECK_CODE")
    let host = param("E2E_RELAY_HOST")
    foreground()
    let card = byId("pair-confirm")
    until(timeout("E2E_WAIT", 30), "pair-confirm card") { card.exists }
    let codeEl = byId("pair-check-code")
    XCTAssertTrue(codeEl.waitForExistence(timeout: 5), "pair-check-code")
    out("check_code_label", codeEl.label)
    XCTAssertTrue(codeEl.label.contains(code), "check code on card (\(codeEl.label)) != daemon's \(code)")
    XCTAssertTrue(labelContains(host).waitForExistence(timeout: 5), "relay host \(host) not shown on the card")
    out("replaces_shown", byId("pair-replaces").exists ? "yes" : "no")
    attachScreenshot("pair-confirm")
    byId("pair-connect").tap()
    let status = byId("now-connections")
    until(timeout("E2E_WAIT_ONLINE", 60), "此刻 with 家里的电脑 · 在线") {
      status.exists && (status.label.contains("在线") || status.label.lowercased().contains("online"))
    }
    out("status_label", status.label)
    XCTAssertTrue(byId("now-say").exists, "此刻 page (now-say) not visible")
    attachScreenshot("now-online")
  }

  /// a'. 同一个链接再开一次:确认卡 → 连接 ⇒「已经用过或过期」;退回此刻,仍是在线(没把现在的配对弄坏)。
  func testPairReuseRejected() {
    foreground()
    let card = byId("pair-confirm")
    until(timeout("E2E_WAIT", 30), "pair-confirm card (reused link)") { card.exists }
    byId("pair-connect").tap()
    let err = byId("pair-error")
    until(timeout("E2E_WAIT", 30), "pair-error") { err.exists }
    let msg = anyLabel(["已经用过或过期", "already used or has expired"])
    XCTAssertTrue(msg.waitForExistence(timeout: 5), "expected the 已经用过或过期 message")
    out("reuse_error", msg.label)
    attachScreenshot("pair-reused")
    // 回此刻:错误态的返回先回配对页开头,再返回才出页面
    for _ in 0..<3 where !byId("now-say").exists {
      let back = byId("topbar-back")
      if back.exists { back.tap() }
      Thread.sleep(forTimeInterval: 1)
    }
    let status = byId("now-connections")
    until(timeout("E2E_WAIT_ONLINE", 60), "此刻 still online after the rejected reuse") {
      status.exists && (status.label.contains("在线") || status.label.lowercased().contains("online"))
    }
  }

  /// b. 跟 CC 说一句:此刻 → 说一句入口 → 对话页 → 打字 → 发送 ⇒ 自己的气泡出现 ⇒ 等一条**新的** CC 气泡(发送前没有的那条)。
  func testChat() {
    let text = param("E2E_CHAT_TEXT")
    foreground()
    let say = byId("now-say")
    until(timeout("E2E_WAIT", 30), "now-say") { say.exists }
    say.tap()
    let input = byId("chat-input")
    until(timeout("E2E_WAIT", 30), "chat-input") { input.exists }
    Thread.sleep(forTimeInterval: 2) // 等历史那一页拉完,免得把旧回复当成新的
    let ccBubbles = app.descendants(matching: .any).matching(identifier: "chat-bubble-cc")
    var before = Set<String>()
    for i in 0..<ccBubbles.count { before.insert(ccBubbles.element(boundBy: i).label) }
    out("cc_bubbles_before", "\(before.count)")
    input.tap()
    input.typeText(text)
    let send = byId("chat-send")
    until(10, "chat-send enabled") { send.exists && send.isEnabled }
    send.tap()
    let mine = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'chat-bubble-me' AND label CONTAINS %@", text)).firstMatch
    until(timeout("E2E_WAIT", 30), "own bubble") { mine.exists }
    out("thinking_seen", byId("chat-thinking").exists ? "yes" : "no")
    attachScreenshot("chat-sent")
    var reply: String?
    until(timeout("E2E_WAIT_REPLY", 240), "a new CC reply bubble") {
      if self.byId("chat-thinking").exists { return false }
      for i in 0..<ccBubbles.count {
        let l = ccBubbles.element(boundBy: i).label
        if !before.contains(l) { reply = l; return true }
      }
      return false
    }
    out("reply_label", String((reply ?? "").prefix(160)))
    attachScreenshot("chat-reply")
    // 回此刻,给下一步留一个确定的起点
    let back = byId("topbar-back")
    if back.exists { back.tap() }
  }

  /// c-1. 把 app 放到后台(回主屏幕)。之后 daemon 发出的推送走 APNs + 通知服务扩展。
  func testBackground() {
    foreground()
    XCUIDevice.shared.press(.home)
    until(10, "app in background") { app.state == .runningBackground || app.state == .runningBackgroundSuspended || app.state == .notRunning }
    out("app_state", "\(app.state.rawValue)")
  }

  /// c-2. 等系统横幅(解密后的标题 + 任务标题),点它 ⇒ 批准页 ⇒ 允许 ⇒ 回到这件事的进展页。
  /// 横幅已经收起 ⇒ 从屏幕顶端下拉通知中心找同一条。
  func testTapPushAndApprove() {
    let taskTitle = param("E2E_TASK_TITLE")
    let titles = ["需要你批准", "Needs your approval"]
    let wait = timeout("E2E_WAIT_PUSH", 150)
    let preds = [NSPredicate(format: "label CONTAINS %@", taskTitle)]
    let match = springboard.descendants(matching: .any).matching(NSCompoundPredicate(andPredicateWithSubpredicates: preds))
    var found: XCUIElement?
    let end = Date().addingTimeInterval(wait)
    var openedCenter = false
    while Date() < end && found == nil {
      // 只认标题已经是解密后的那条(扩展没跑 / 解不开时是「CC 有新动态」,不算)
      func decrypted() -> XCUIElement? {
        for i in 0..<min(match.count, 6) {
          let el = match.element(boundBy: i)
          if el.exists && titles.contains(where: { el.label.contains($0) }) { return el }
        }
        return nil
      }
      if decrypted() != nil {
        // 同一件事可能还有第二条在路上(同 collapse-id,后到的顶掉前一条):等它落定再看一眼,仍是解密的那条才点
        Thread.sleep(forTimeInterval: 3)
        found = decrypted()
        if found != nil { break }
        out("decrypted_banner_replaced", "yes")
      }
      // 横幅默认显示约 5 秒;等了 40 秒还没看到 ⇒ 去通知中心找(推送可能在这一步开始前就到了)
      if !openedCenter && Date() > end.addingTimeInterval(-(wait - 40)) {
        openedCenter = true
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.005))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.7)))
        out("opened_notification_center", "yes")
      }
      Thread.sleep(forTimeInterval: 0.3)
    }
    guard let banner = found else {
      let neutral = labelContains("CC 有新动态", in: springboard).exists || labelContains("CC has news", in: springboard).exists
      out("neutral_placeholder_seen", neutral ? "yes" : "no")
      XCTFail("no decrypted notification for \(taskTitle) within \(Int(wait))s")
      return
    }
    out("banner_label", banner.label)
    out("banner_source", openedCenter ? "notification_center" : "banner")
    attachScreenshot("push-banner")
    banner.tap()
    let allow = byId("approval-allow")
    let end2 = Date().addingTimeInterval(timeout("E2E_WAIT", 45))
    while Date() < end2 && !(allow.exists && allow.isEnabled) {
      acceptSystemAlerts()
      Thread.sleep(forTimeInterval: 0.5)
    }
    if !(allow.exists && allow.isEnabled) {
      // 点开却落在此刻:app 解不开点到的那条(扩展解开的那条被同 collapse-id 的另一条顶掉了)——见 README「真机全自动验收 · 已知」
      out("landed_on_now", byId("now-needs-you-card").exists ? "yes_with_waiting_card" : (byId("now-say").exists ? "yes" : "no"))
      XCTFail("tapping the notification did not open the approval page")
      return
    }
    out("approval_title", byId("approval-title").exists ? byId("approval-title").label : "")
    out("raw_inline", byId("approval-raw-inline").exists ? byId("approval-raw-inline").label : "")
    attachScreenshot("approval")
    allow.tap()
    let progress = byId("progress-status")
    until(timeout("E2E_WAIT", 45), "progress page after allow") { progress.exists }
    out("progress_status", progress.label)
  }

  /// d. daemon 撤销了这台测试设备 ⇒ app 显示「这台手机已不再配对」。
  func testRevokedNotice() {
    foreground()
    // 回到此刻(撤销卡在此刻页);从进展页 / 对话页最多返回三次
    for _ in 0..<3 where !byId("now-say").exists {
      let back = byId("topbar-back")
      if back.exists { back.tap() } else { break }
      Thread.sleep(forTimeInterval: 1)
    }
    let notice = byId("conn-notice-revoked")
    until(timeout("E2E_WAIT", 90), "conn-notice-revoked") { notice.exists }
    let title = anyLabel(["这台手机已不再配对", "no longer paired"])
    XCTAssertTrue(title.exists, "revoked title text")
    out("revoked_label", title.label)
    attachScreenshot("revoked")
  }

  /// e. 放回主人的配对之后冷启动:此刻在线(主人那台设备位重新连上)。
  func testOwnerOnline() {
    foreground()
    let status = byId("now-connections")
    until(timeout("E2E_WAIT_ONLINE", 60), "owner pairing back online") {
      status.exists && (status.label.contains("在线") || status.label.lowercased().contains("online"))
    }
    out("status_label", status.label)
  }
}
