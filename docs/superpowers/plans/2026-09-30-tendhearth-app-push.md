# Tendhearth app 原生通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配对后的手机能收到「需要你决定 / 做完了 / 没做成」的系统通知:app 登记推送(权限、APNs / FCM token、推送密钥进共享钥匙串、`POST /m/api/push/register`),iOS 通知服务扩展(Swift)与安卓消息服务(Kotlin)在本机用与 `openPush` 相同的算法解密、按种类本地化显示、去重;点通知(冷 / 温 / 前台)先拉最新详情再进批准页或进展页;撤销与解除配对清掉推送密钥。

**Architecture:** 推送密钥 = `derivePushKey(设备令牌)`,由 app 推出后以 `{v,key,lang}` 记录单独存一条钥匙串(iOS 在与扩展共享的 access group,安卓在 expo-secure-store 的同一份存储里由 Kotlin 直接读);设备令牌本身永远不进共享组。原生解密核心(Swift `PushCore`、Kotlin `com.tendhearth.app.push`)是纯函数,各自在 Mac 上用 `swift test` / JVM Gradle 跑 `packages/protocol/vectors/push.json`;扩展与服务只是薄壳,由 `apps/app/plugins/` 下的 config plugin 在 prebuild 时拷进 `ios/` / `android/`(两者不进 git)。点通知统一走 `tendhearth://push-open?kind=&taskId=&requestId=` → `src/app/push-open.tsx`(iOS 由 expo-notifications 的响应监听转过去,安卓由 Kotlin 的 PendingIntent 直接深链)。

**Tech Stack:** Expo SDK 57、expo-notifications、expo-secure-store 57.x、Expo config plugins(`xcode` 3.0.1)、Swift 5.9 + CryptoKit(SwiftPM,`swift test`)、Kotlin 2.3.20 + JUnit 4 + org.json(Gradle 9.1.0,JDK 21)、vitest、Maestro、`xcrun simctl push`。

**Spec:** `docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`(§3 状态约定、§4 身份与存储、§7 通知、§9 测试)。前序计划:`2026-09-30-tendhearth-app-backend.md`(推送载荷 `requestId`、时间窗放宽、向量 `cases`)、`2026-09-30-tendhearth-app-skeleton.md`、`2026-09-30-tendhearth-app-live.md`(真连接与配对;其「Next plan」即本计划,裁决 8 把配对后的通知权限与登记移到这里)。

## Global Constraints

- 工作树 `.claude/worktrees/deploy-dev`,分支 `app-push`(基于 `origin/dev` 9f1436f2),PR 进 `dev`(squash);不切分支、不碰兄弟工作树、不用 `git stash`、不暂存 `.superpowers/`。
- **daemon 行为不改**(本计划没有任何一处需要改 daemon;推送标题的本地化在原生端按 `kind` 做,见裁决 2)。协议包只做纯增量(`pushDedupeKey`、`makePushDedupe`、向量补用例)。
- **令牌与密钥永不进日志**:设备令牌、推送密钥、APNs / FCM token 都不写进 `console` / `os_log` / `Log` / 错误文案;日志只写操作名与错误码(`register.test.ts` 钉住)。
- 钥匙串:配对记录 `tendhearth.pairing.v1`、偏好 `tendhearth.prefs.v1`(不变,默认 service,**不在共享组**);推送密钥记录 `tendhearth.pushkey.v1`(service `tendhearth.push`,iOS access group `9Y6JAPDP7A.com.tendhearth.app.shared`,`AFTER_FIRST_UNLOCK`);登记指纹 `tendhearth.pushreg.v1`(默认 service,本地)。
- 推送密钥记录格式:`{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}`(`lang` = 设置里的手动覆盖,null = 跟系统)。
- iOS 主 app 的 `keychain-access-groups` = `[$(AppIdentifierPrefix)com.tendhearth.app, $(AppIdentifierPrefix)com.tendhearth.app.shared]`(**自己的组排第一**,不带 accessGroup 的写入仍落在私有组);扩展只有 `[$(AppIdentifierPrefix)com.tendhearth.app.shared]`。扩展 bundle id `com.tendhearth.app.notify`,target 名 `TendhearthNotify`。
- 推送种类 → 展示:`permission` ⇒ iOS category `th.approval` / 安卓渠道 `decide`;`question` ⇒ `th.question` / `decide`;`task_done` ⇒ `th.done` / `updates`;`task_failed` ⇒ `th.failed` / `updates`;`test` ⇒ `th.test` / `updates`。category **不带任何动作**(spec §1:通知本身从不执行操作)。
- 解不开(无密钥、错钥、篡改、过期、未来、畸形、明文不合 `PushPlaintext`)或扩展超时 ⇒ 中性占位「CC 有新动态 / CC has news」,点开回「此刻」。
- 去重键 = `floor(ts) + ":" + sha256(ct 原文 UTF-8) 的前 32 位 hex`;每台设备记最近 64 条、每条留 `PUSH_MAX_AGE_MS + PUSH_MAX_SKEW_MS` = 4 200 000 ms。
- 原生源码只在 `apps/app/native/`,由 `apps/app/plugins/*.js` 在 prebuild 时拷贝 / 生成;`ios/`、`android/`、`google-services.json`、`GoogleService-Info.plist` 不进 git。
- 原生依赖只用 `bunx expo install`(版本跟 SDK 57)。
- 所有面向用户的 JS 文案进 `src/i18n/en.ts` 与 `src/i18n/zh-Hans.ts`(两份键一致);原生文案只在 `apps/app/native/push-strings.json`(两种语言键一致、渠道名与 JS 文案一致,测试钉住)。
- iOS app 的系统权限说明(`locales/`)**en 与 zh-Hans 必须同时加**(计划 3 裁决:只有 zh 的 locale 会把 en-GB 用户的 app 语言翻成中文)。
- 被根目录测试 import 的 app 文件(本计划新增 `apps/app/src/push/{key-store,target,route,register}.ts`)必须是纯 TS:不 import `react` / `react-native` / `expo-*`,类型 `import type`,数组下标带 `!` 或判空(根 tsconfig 有 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`)。
- 回路(看退出码,别 grep 输出判成败):
  - app:`cd apps/app && bun run test && bun run typecheck && bun run export:check`
  - 原生:`cd apps/app/native/ios-notify && swift test`;`apps/app/native/android-push/test.sh`
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
- 模拟器:本计划自己建一台 `th-push`(`xcrun simctl create th-push "iPhone 17 Pro"`),**不碰已经开着的别的模拟器**(可能是别的会话的)。

## Review Focus

1. **电脑上已经处理掉的批准、或已删掉的事,手机上点旧通知**:不出现还能点的「允许」—— 请求已不在 ⇒ 批准页显示「已处理」;事情不在 ⇒ 中转页说「这件事在电脑上已经不在了」+ 回此刻(Task 6 `route.test.ts`、Task 10 Maestro)。
2. **手机被撤销 / 解除配对之后推送还在来**:推送密钥当场从钥匙串清掉,扩展 / 服务只能显示占位;冷启动发现「没配对却留着推送密钥」也清(Task 9 `session-store.test.ts`、`push-state.test.ts`)。
3. **用户先拒了通知权限、后来去系统设置打开、再回到 app**:回前台时重新检查并登记,设置页的状态跟着变(Task 5 `shouldSync` 表、Task 9)。
4. **手机重启后第一次解锁前来了推送 / 钥匙串读不到密钥**:显示占位不崩;之后点开回此刻;app 端若能解开则照常路由(Task 3/4 原生测试「无密钥 ⇒ 占位」、Task 6 兜底解密测试)。
5. **别的 app / 网页伪造 `tendhearth://push-open?taskId=../../x&requestId=<超长>` 深链**:参数不合形状一律丢掉 ⇒ 回此刻,不发任何请求到奇怪的路径(Task 6 `target.test.ts`)。

---

## File Structure

```
packages/protocol/src/push.ts               + pushDedupeKey、makePushDedupe、PUSH_DEDUPE_CAPACITY、PUSH_DEDUPE_TTL_MS
packages/protocol/src/push.test.ts          + 去重、新 expect 'invalid'、dedupe.steps
packages/protocol/src/index.ts              导出上面几个
scripts/gen-push-vectors.ts                 + invalid-kind 用例、ok 用例带 dedupeKey、顶层 dedupe.steps
packages/protocol/vectors/push.json         重新生成(顶层回归钉子不变)
src/daemon/phone-app-push-e2e.test.ts       新:daemon 真 makePhonePush 封的推送,app 推出的密钥能解开、能路由
src/daemon/phone-app-live-e2e.test.ts       + 没接推送的 daemon ⇒ registerPush 报 unavailable
apps/app/
  README.md                                 推送一节(Task 1 起头,Task 12 补全)
  app.json                                  + locales;expo-notifications 等插件移到 app.config.js
  app.config.js                             新:APNs 环境、钥匙串组、google-services、原生插件、EAS 扩展声明
  eas.json                                  新:development / preview / production 三个构建配置(不运行)
  .gitignore                                + google-services.json、GoogleService-Info.plist、native 构建目录
  vitest.config.ts                          include + plugins/**、scripts/**
  locales/en.json  locales/zh-Hans.json     iOS 权限说明(相机)+ 显示名
  assets/images/android-icon-monochrome.png 由 CC 素材生成的单色图
  assets/images/notification-icon.png       96×96 白色剪影(安卓通知小图标)
  native/push-strings.json                  原生通知文案(en / zh-Hans)
  native/ios-notify/Package.swift           SwiftPM:PushCore + 测试(只为 swift test)
  native/ios-notify/Sources/PushCore/*.swift  Base64URL、PushCrypto、PushMessage、PushPresenter、PushDedupe、PushKeyRecord
  native/ios-notify/Tests/PushCoreTests/*.swift
  native/ios-notify/Extension/NotificationService.swift  扩展入口
  native/ios-notify/Extension/ExtensionStores.swift      钥匙串读密钥 + UserDefaults 去重
  native/android-push/build.gradle.kts  settings.gradle.kts  test.sh   JVM 单测
  native/android-push/src/main/kotlin/com/tendhearth/app/push/*.kt   Base64Url、PushCrypto、PushMessage、PushPresenter、PushDedupe、PushKeyRecord
  native/android-push/src/test/kotlin/com/tendhearth/app/push/*.kt
  native/android-push/android/TendhearthMessagingService.kt   安卓消息服务(只进 android/,不进 JVM 构建)
  native/android-push/android/SecureStoreReader.kt           读 expo-secure-store 的存储
  plugins/push-strings.js                   由 push-strings.json 生成 Swift / Kotlin 源码
  plugins/with-ios-notify.js                iOS:扩展 target、entitlements、Info.plist、拷源码
  plugins/with-android-push.js              安卓:拷源码、manifest、firebase 依赖、权限
  plugins/*.test.ts                         生成器、app.config、原生格式守卫
  scripts/sim-push-lib.ts  scripts/sim-push.ts  scripts/sim-push-lib.test.ts   模拟器推送
  src/backend/types.ts  live.ts  demo.ts    + registerPush / testPush;BackendCode + 'unavailable';demo 找不到 ⇒ not_found
  src/net/errors.ts                         push_not_wired ⇒ unavailable
  src/push/key-store.ts                     推送密钥记录与登记指纹(纯)
  src/push/register.ts                      syncPush / platformFor / permState / shouldSync(纯)
  src/push/target.ts                        通知 / 深链 → PushTarget(纯,含兜底解密)
  src/push/route.ts                         resolvePushRoute / hrefFor / pushOpenHref(纯)
  src/push/banner.ts                        bannerFrom(纯)
  src/push/native.ts                        expo-notifications 与钥匙串的真实例(RN)
  src/push/PushProvider.tsx                 登记生命周期 + usePush()
  src/push/PushRouter.tsx                   点通知 → 中转页;前台横幅
  src/ui/PushBanner.tsx                     app 内横幅
  src/view/notifications.ts                 设置页通知状态文案(纯)
  src/state/session-store.ts  session.tsx   撤销 / 解除配对时一并清推送密钥
  src/app/push-open.tsx                     点通知的中转页
  src/app/dev-push-key.tsx                  仅开发构建:存一把合成的推送密钥(模拟器验证用)
  src/app/_layout.tsx  settings.tsx         挂 PushProvider / PushRouter;设置里的通知一节
  src/i18n/en.ts  zh-Hans.ts                新文案
  .maestro/push-open.yaml                   演示模式下的点通知路由
.github/workflows/ci.yml                    + app · native push vectors 作业(macOS:swift test + gradle test)
docs/roadmap.md  docs/INDEX.md  docs/maintainer/relay.md
```

---

### Task 1: 探路 —— 模拟器上 `simctl push` 会不会跑通知服务扩展、共享钥匙串组在模拟器上能不能用

不写产品代码。结论决定 Task 11 的本机验证方式,写进 `apps/app/README.md`。

**Files:**
- Scratch(不进仓库):`/tmp/th-nse-spike/`
- Modify: `apps/app/README.md`(新增「推送(原生通知)」一节,只写探路结论)

**Interfaces:**
- Produces:README 里三条结论 —— `NSE_UNDER_SIMCTL=yes|no`、`SHARED_KEYCHAIN_ON_SIM=yes|no`、模拟器构建需要的签名参数;Task 11 按 `NSE_UNDER_SIMCTL` 走两条分支之一。

- [ ] **Step 1: 建专用模拟器**

```bash
UDID=$(xcrun simctl create th-push "iPhone 17 Pro") && xcrun simctl boot "$UDID" && echo "$UDID" > /tmp/th-push-udid
open -a Simulator
```
Expected:打印出 UDID;`xcrun simctl list devices | grep th-push` 显示 `(Booted)`。

- [ ] **Step 2: 用 xcodegen 生成一个带通知服务扩展的最小工程**

```bash
mkdir -p /tmp/th-nse-spike/App /tmp/th-nse-spike/Notify && cd /tmp/th-nse-spike
cat > project.yml <<'EOF'
name: Spike
options:
  bundleIdPrefix: com.tendhearth.spike
  deploymentTarget: { iOS: "17.0" }
settings:
  base:
    DEVELOPMENT_TEAM: 9Y6JAPDP7A
    SWIFT_VERSION: "5.0"
targets:
  Spike:
    type: application
    platform: iOS
    sources: [App]
    info:
      path: App/Info.plist
      properties: { UILaunchScreen: {} }
    entitlements:
      path: App/Spike.entitlements
      properties:
        aps-environment: development
        keychain-access-groups: ["$(AppIdentifierPrefix)com.tendhearth.spike.Spike", "$(AppIdentifierPrefix)com.tendhearth.spike.shared"]
    dependencies:
      - target: Notify
        embed: true
  Notify:
    type: app-extension
    platform: iOS
    sources: [Notify]
    info:
      path: Notify/Info.plist
      properties:
        NSExtension:
          NSExtensionPointIdentifier: com.apple.usernotifications.service
          NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService"
    entitlements:
      path: Notify/Notify.entitlements
      properties:
        keychain-access-groups: ["$(AppIdentifierPrefix)com.tendhearth.spike.shared"]
EOF
cat > App/App.swift <<'EOF'
import SwiftUI
import UserNotifications
import Security

@main struct SpikeApp: App {
  @State var status = "…"
  var body: some Scene {
    WindowGroup {
      Text(status).padding().onAppear {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in
          let group = "9Y6JAPDP7A.com.tendhearth.spike.shared"
          let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "spike:no-auth",
                                     kSecAttrAccount as String: Data("k".utf8), kSecAttrAccessGroup as String: group]
          SecItemDelete(base as CFDictionary)
          var add = base
          add[kSecValueData as String] = Data("hello".utf8)
          add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
          let st = SecItemAdd(add as CFDictionary, nil)
          DispatchQueue.main.async { status = "notif=\(ok) keychainAdd=\(st)" }
        }
      }
    }
  }
}
EOF
cat > Notify/NotificationService.swift <<'EOF'
import UserNotifications
import Security
import os

final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let c = request.content.mutableCopy() as! UNMutableNotificationContent
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "spike:no-auth",
                            kSecAttrAccount as String: Data("k".utf8), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    let v = (out as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? "-"
    Logger(subsystem: "com.tendhearth.spike", category: "nse").notice("nse ran keychain=\(st) value=\(v, privacy: .public)")
    c.title = "[nse] " + c.title
    c.body = "keychain=\(st) value=\(v)"
    contentHandler(c)
  }
}
EOF
xcodegen generate
```
Expected:`Spike.xcodeproj` 生成,无报错。

- [ ] **Step 3: 为模拟器构建、安装、授权**

```bash
cd /tmp/th-nse-spike && UDID=$(cat /tmp/th-push-udid)
xcodebuild -project Spike.xcodeproj -scheme Spike -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath build build 2>&1 | tail -5
```
若报签名 / 账号错误,依次试:追加 `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual`;仍不行再加 `CODE_SIGNING_ALLOWED=NO`(这时 entitlements 可能不生效,记下来)。把**最终能过的参数**记下。

```bash
xcrun simctl install "$UDID" build/Build/Products/Debug-iphonesimulator/Spike.app
xcrun simctl launch "$UDID" com.tendhearth.spike.Spike
cat > /tmp/th-nse-spike/allow.yaml <<'EOF'
appId: com.tendhearth.spike.Spike
---
- tapOn: "Allow"
EOF
maestro --device "$UDID" test /tmp/th-nse-spike/allow.yaml
xcrun simctl io "$UDID" screenshot /tmp/th-nse-spike/app.png
```
用 Read 工具看 `/tmp/th-nse-spike/app.png`:记下 `notif=true keychainAdd=0`(0 = 成功;`-34018` = 缺 entitlement)。

- [ ] **Step 4: 推送并观察扩展是否运行**

```bash
cd /tmp/th-nse-spike && UDID=$(cat /tmp/th-push-udid)
cat > push.apns <<'EOF'
{"aps":{"alert":{"title":"CC","body":"CC 有新动态"},"mutable-content":1,"sound":"default"}}
EOF
xcrun simctl launch "$UDID" com.apple.Preferences     # 让 Spike 进后台
xcrun simctl push "$UDID" com.tendhearth.spike.Spike push.apns
sleep 3 2>/dev/null || true
xcrun simctl io "$UDID" screenshot /tmp/th-nse-spike/push.png
xcrun simctl spawn "$UDID" log show --last 2m --style compact --predicate 'subsystem == "com.tendhearth.spike"' | tail -5
```
(`sleep` 若被拦,就用 Monitor 等 3 秒或直接执行下一条。)

用 Read 看 `push.png`:
- 横幅标题是 `[nse] CC`、正文 `keychain=0 value=hello` ⇒ `NSE_UNDER_SIMCTL=yes`、`SHARED_KEYCHAIN_ON_SIM=yes`;
- 标题 `[nse] CC` 但 `keychain=-25300`(找不到)或 `-34018` ⇒ `NSE_UNDER_SIMCTL=yes`、`SHARED_KEYCHAIN_ON_SIM=no`;
- 横幅是原样的 `CC / CC 有新动态`、日志里没有 `nse ran` ⇒ `NSE_UNDER_SIMCTL=no`。

横幅已经收掉的话,下拉通知中心再截一张。

- [ ] **Step 5: 把结论写进 README,清掉 scratch 工程**

在 `apps/app/README.md` 的「真连接的规矩」一节之后新增:

```markdown
## 推送(原生通知)

计划:`docs/superpowers/plans/2026-09-30-tendhearth-app-push.md`。

### 本机能验证什么(2026-09-30 探路,Xcode 27 / iOS 26.5 模拟器)

- `xcrun simctl push` 会不会运行通知服务扩展:**<yes|no>**(<一句观察:横幅被改写 / 日志里有 nse ran>)
- 模拟器上 app 与扩展共享钥匙串组:**<yes|no>**(SecItemAdd = <status>,扩展读到 <status>)
- 模拟器构建的签名参数:`<最终能过的 xcodebuild 追加参数,没有就写「无需额外参数」>`
- 真 APNs / FCM 投递、锁屏、进程被杀后的送达:只能真机 + 主人的 APNs 密钥 / Firebase 项目(见文末「主人要做的」)。
```

```bash
rm -rf /tmp/th-nse-spike
git add apps/app/README.md
git commit -m "app 推送:探路结论 —— simctl push 与通知服务扩展、模拟器共享钥匙串

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(模拟器 `th-push` 留着,Task 7 / 10 / 11 还要用。)

---

### Task 2: 协议包 —— 去重键、去重参考实现、向量补用例

**Files:**
- Modify: `packages/protocol/src/push.ts`、`packages/protocol/src/index.ts`、`scripts/gen-push-vectors.ts`、`packages/protocol/vectors/push.json`(生成)
- Test: `packages/protocol/src/push.test.ts`

**Interfaces:**
- Produces:
  - `export const PUSH_DEDUPE_CAPACITY = 64`
  - `export const PUSH_DEDUPE_TTL_MS = PUSH_MAX_AGE_MS + PUSH_MAX_SKEW_MS`(4 200 000)
  - `export function pushDedupeKey(ts: number, ct: string): string` —— `${Math.floor(ts)}:${sha256hex(utf8(ct)).slice(0, 32)}`
  - `export function makePushDedupe(entries?: Record<string, number>): { seen(key: string, now: number): boolean; entries(): Record<string, number> }`
  - 向量文件新增:每个 `expect: 'ok'` 用例带 `dedupeKey`;新用例 `invalid-kind`(`expect: 'invalid'`:`openPush` 能解开、`PushPlaintext` 拒);顶层 `dedupe: { capacity, ttlMs, steps: [{ key, now, expect: 'new'|'duplicate', note }] }`。Swift / Kotlin(Task 3 / 4)照这个文件验收。

- [ ] **Step 1: 写失败的测试**

在 `packages/protocol/src/push.test.ts` 顶部 import 改成:

```ts
import { derivePushKey, sealPush, openPush, PushPlaintext, PushKind, pushDedupeKey, makePushDedupe, PUSH_DEDUPE_CAPACITY, PUSH_DEDUPE_TTL_MS } from './push'
```

把「向量文件的每个 case 与实现一致」里的循环体换成(新增 `invalid` 分支、`ok` 核对 `dedupeKey`):

```ts
    for (const c of v.cases as Array<{ name: string; now: number; sealed: SealedPush; expect: string; wrongKey?: boolean; payload?: unknown; dedupeKey?: string }>) {
      const k = c.wrongKey ? wrong : key
      if (c.expect === 'ok') {
        expect(openPush(k, c.sealed, c.now), c.name).toEqual(c.payload)
        expect(pushDedupeKey((c.payload as { ts: number }).ts, c.sealed.ct), c.name).toBe(c.dedupeKey)
      } else if (c.expect === 'invalid') {
        expect(PushPlaintext.safeParse(openPush(k, c.sealed, c.now)).success, c.name).toBe(false)
      } else if (c.expect === 'stale') expect(() => openPush(k, c.sealed, c.now), c.name).toThrow('stale')
      else expect(() => openPush(k, c.sealed, c.now), c.name).toThrow()
    }
    expect((v.cases as Array<{ expect: string }>).map(c => c.expect)).toEqual(expect.arrayContaining(['ok', 'invalid', 'stale', 'auth', 'malformed']))
```

文件末尾(`gcmEncryptRaw` 之前)加:

```ts
describe('去重(spec §5.5:每台设备按 ts + 密文哈希记住最近的推送)', () => {
  it('pushDedupeKey:floor(ts) + ":" + sha256(ct) 前 32 位 hex;ts 的小数部分不影响', () => {
    const k = pushDedupeKey(1_700_000_000_123.9, 'abc')
    expect(k).toBe('1700000000123:ba7816bf8f01cfea414140de5dae2223')   // sha256("abc")
    expect(pushDedupeKey(1_700_000_000_123, 'abc')).toBe(k)
    expect(pushDedupeKey(1_700_000_000_123, 'abd')).not.toBe(k)
  })
  it('makePushDedupe:第一次 new、第二次 duplicate;超过 TTL 的条目被修剪后又算 new', () => {
    const d = makePushDedupe()
    expect(d.seen('a', 1000)).toBe(false)
    expect(d.seen('a', 2000)).toBe(true)
    expect(d.seen('a', 1000 + PUSH_DEDUPE_TTL_MS)).toBe(true)          // 正好 TTL:还留着
    expect(d.seen('a', 1000 + PUSH_DEDUPE_TTL_MS + 1)).toBe(false)     // 超过 TTL:修剪后重新记下
  })
  it('容量满了挤掉最早见到的那条(同一时刻按键名排序,确定性)', () => {
    const d = makePushDedupe()
    for (let i = 0; i < PUSH_DEDUPE_CAPACITY; i++) d.seen(`k${String(i).padStart(3, '0')}`, 1000 + i)
    expect(d.seen('new', 5000)).toBe(false)
    expect(Object.keys(d.entries())).toHaveLength(PUSH_DEDUPE_CAPACITY)
    expect(d.entries()['k000']).toBeUndefined()
    expect(d.seen('k001', 5001)).toBe(true)
  })
  it('向量文件的 dedupe.steps 与参考实现一致(原生两端照同一份跑)', () => {
    const v = JSON.parse(readFileSync(new URL('../vectors/push.json', import.meta.url), 'utf8'))
    expect(v.dedupe.capacity).toBe(PUSH_DEDUPE_CAPACITY)
    expect(v.dedupe.ttlMs).toBe(PUSH_DEDUPE_TTL_MS)
    const d = makePushDedupe()
    for (const s of v.dedupe.steps as Array<{ key: string; now: number; expect: string; note: string }>) {
      expect(d.seen(s.key, s.now) ? 'duplicate' : 'new', s.note).toBe(s.expect)
    }
    expect((v.dedupe.steps as Array<{ expect: string }>).map(s => s.expect)).toContain('duplicate')
  })
  it('从 index 导出', () => {
    expect(index.pushDedupeKey).toBe(pushDedupeKey)
    expect(index.makePushDedupe).toBe(makePushDedupe)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun --bun vitest run packages/protocol/src/push.test.ts`
Expected: FAIL(`pushDedupeKey` 未导出)。

- [ ] **Step 3: 实现**

`packages/protocol/src/push.ts` 在 `PUSH_MAX_SKEW_MS` 之后加:

```ts
/** 每台设备记住最近见过的推送(spec §5.5):条数上限与每条保留时长。原生两端(Swift / Kotlin)用同样的数。 */
export const PUSH_DEDUPE_CAPACITY = 64
export const PUSH_DEDUPE_TTL_MS = PUSH_MAX_AGE_MS + PUSH_MAX_SKEW_MS

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

/** 去重键 = floor(ts) + ":" + sha256(ct 原文的 UTF-8)前 32 位 hex。ct 是线上的 base64url 字符串本身。 */
export function pushDedupeKey(ts: number, ct: string): string {
  return `${Math.floor(ts)}:${hex(sha256(new TextEncoder().encode(ct))).slice(0, 32)}`
}

/**
 * 去重的参考实现(原生端照它写;向量文件的 dedupe.steps 钉住)。seen:先修剪 now - 记下时刻 > TTL 的条目;
 * 已有 ⇒ true(重复);否则记下,超出容量就挤掉记下时刻最早的(同一时刻按键名升序)⇒ false。
 */
export function makePushDedupe(initial: Record<string, number> = {}): { seen(key: string, now: number): boolean; entries(): Record<string, number> } {
  const m = new Map(Object.entries(initial))
  return {
    seen(key, now) {
      for (const [k, at] of m) if (now - at > PUSH_DEDUPE_TTL_MS) m.delete(k)
      if (m.has(key)) return true
      m.set(key, now)
      while (m.size > PUSH_DEDUPE_CAPACITY) {
        let oldest: [string, number] | null = null
        for (const e of m) if (!oldest || e[1] < oldest[1] || (e[1] === oldest[1] && e[0] < oldest[0])) oldest = e
        m.delete(oldest![0])
      }
      return false
    },
    entries: () => Object.fromEntries(m),
  }
}
```

`packages/protocol/src/index.ts`:把 push 那一行的导出补上 `pushDedupeKey, makePushDedupe, PUSH_DEDUPE_CAPACITY, PUSH_DEDUPE_TTL_MS`(先 `grep -n "from './push'" packages/protocol/src/index.ts` 找到那行,按原格式追加)。

`scripts/gen-push-vectors.ts`:import 追加 `pushDedupeKey, PUSH_DEDUPE_CAPACITY, PUSH_DEDUPE_TTL_MS`;在 `const tampered` 之前加

```ts
// 能解开、但明文不合 PushPlaintext(kind 不认识)⇒ 原生端必须按「解不开」处理(显示占位)。
const badKind = { ts: NOW - 2000, kind: 'approval_needed', title: 'x', body: 'y' }
```

把 `cases` 换成:

```ts
const okFull = seal(full, 1)
const okLate = seal(late, 2)
const cases = [
  { name: 'ok', now: NOW, sealed: okFull, expect: 'ok', payload: full, dedupeKey: pushDedupeKey(full.ts, okFull.ct) },
  { name: 'ok-late-50min', now: NOW, sealed: okLate, expect: 'ok', payload: late, dedupeKey: pushDedupeKey(late.ts, okLate.ct) },
  { name: 'stale-past-61min', now: NOW, sealed: seal({ ts: NOW - 61 * MIN }, 3), expect: 'stale' },
  { name: 'stale-future-11min', now: NOW, sealed: seal({ ts: NOW + 11 * MIN }, 4), expect: 'stale' },
  { name: 'auth-wrong-key', wrongKey: true, now: NOW, sealed: seal({ ts: NOW }, 5), expect: 'auth' },
  { name: 'auth-tampered', now: NOW, sealed: { ...tampered, ct: b64uEncode(ctBytes) }, expect: 'auth' },
  { name: 'malformed-v2', now: NOW, sealed: { ...seal({ ts: NOW }, 6), v: 2 }, expect: 'malformed' },
  { name: 'invalid-kind', now: NOW, sealed: seal(badKind, 7), expect: 'invalid' },
]
const k1 = pushDedupeKey(full.ts, okFull.ct)
const k2 = pushDedupeKey(late.ts, okLate.ct)
const dedupe = {
  capacity: PUSH_DEDUPE_CAPACITY,
  ttlMs: PUSH_DEDUPE_TTL_MS,
  steps: [
    { key: k1, now: NOW, expect: 'new', note: '第一次见到 ok' },
    { key: k2, now: NOW, expect: 'new', note: '另一条' },
    { key: k1, now: NOW + 1000, expect: 'duplicate', note: 'APNs / FCM 重投同一条' },
    { key: k1, now: NOW + PUSH_DEDUPE_TTL_MS + 1, expect: 'new', note: '超过保留时长后被修剪' },
  ],
}
```

`out` 里加上 `dedupe`,`_generatedBy` 的补充句改成 `' cases 与 dedupe 是 Swift / Kotlin 解密实现的验收用例(wrongKey 用 deviceToken+"x" 推导的密钥;expect=invalid ⇒ 能解开但明文不合 PushPlaintext)。'`。

生成:

```bash
bun scripts/gen-push-vectors.ts && git diff --stat packages/protocol/vectors/push.json
```
Expected:文件改动;顶层 `deviceToken/key/iv/payload/ct` 不变(`git diff packages/protocol/vectors/push.json | grep '^-  "\(key\|ct\|iv\)"'` 无输出)。

- [ ] **Step 4: 跑测试,确认通过**

Run: `bun --bun vitest run packages/protocol/src/push.test.ts && npx vitest run -c vitest.node.config.ts packages/protocol/src/push.test.ts`
Expected: PASS(两个运行时)。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/push.ts packages/protocol/src/push.test.ts packages/protocol/src/index.ts scripts/gen-push-vectors.ts packages/protocol/vectors/push.json
git commit -m "协议包:推送去重键与参考实现;向量补 invalid-kind、dedupeKey、dedupe.steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 原生文案表 + Swift PushCore(`swift test` 跑共享向量)

**Files:**
- Create: `apps/app/native/push-strings.json`
- Create: `apps/app/native/ios-notify/Package.swift`
- Create: `apps/app/native/ios-notify/Sources/PushCore/{Base64URL,PushCrypto,PushMessage,PushPresenter,PushDedupe,PushKeyRecord}.swift`
- Test: `apps/app/native/ios-notify/Tests/PushCoreTests/{VectorTests,PresenterTests}.swift`
- Modify: `apps/app/.gitignore`

**Interfaces:**
- Consumes:`packages/protocol/vectors/push.json`(Task 2 的 `cases`、`dedupeKey`、`dedupe`)。
- Produces(Swift,模块内 `public`,Task 7 的扩展直接用):
  - `enum PushOpenError { case malformed, auth, stale }`;`struct OpenedPush { payload: [String: Any]; ct: String }`
  - `PushCrypto.open(key: Data, sealed: Any?, nowMs: Int64) -> Result<OpenedPush, PushOpenError>`、`PushCrypto.deriveKey(deviceToken:) -> Data`、`PushCrypto.number(_:) -> NSNumber?`
  - `PushMessage.parse(_ d: [String: Any]) -> PushMessage?`;`.category: String`
  - `PushPresenter.lang(record: String?, preferred: [String]) -> String`、`.placeholder(lang:strings:) -> PushDisplay`、`.display(_:lang:strings:) -> PushDisplay`;`PushDisplay { title, body, category: String?, thread: String?, route: [String: String]? }`
  - `PushDedupe { static key(ts: Double, ct: String) -> String; mutating seen(_ key: String, nowMs: Int64) -> Bool; entries: [String: Int64] }`
  - `PushKeyRecord.parse(_ s: String) -> PushKeyRecord?`(`key: Data`,`lang: String?`)
  - 文案键(`push-strings.json`):`placeholder.title`、`placeholder.body`、`title.<kind>`(五种)、`body.test`、`channel.decide`、`channel.updates`

- [ ] **Step 1: 文案表**

`apps/app/native/push-strings.json`:

```json
{
  "en": {
    "placeholder.title": "CC",
    "placeholder.body": "CC has news",
    "title.permission": "Needs your approval",
    "title.question": "CC has a question",
    "title.task_done": "Done",
    "title.task_failed": "Didn’t finish",
    "title.test": "Test notification",
    "body.test": "Notifications reach this phone.",
    "channel.decide": "Needs your decision",
    "channel.updates": "Done and didn’t finish"
  },
  "zh-Hans": {
    "placeholder.title": "CC",
    "placeholder.body": "CC 有新动态",
    "title.permission": "需要你批准",
    "title.question": "CC 有问题问你",
    "title.task_done": "做完了",
    "title.task_failed": "没做成",
    "title.test": "测试通知",
    "body.test": "通知能送到这台手机。",
    "channel.decide": "需要你决定",
    "channel.updates": "完成与失败"
  }
}
```

- [ ] **Step 2: 包与失败的测试**

`apps/app/native/ios-notify/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

// 只为在 Mac 上 `swift test`:PushCore 是通知服务扩展的纯逻辑(CryptoKit + Foundation)。
// 构建 app 时由 plugins/with-ios-notify.js 把 Sources/PushCore/*.swift 与 Extension/*.swift 一起拷进 ios/TendhearthNotify/。
let package = Package(
  name: "TendhearthNotify",
  platforms: [.macOS(.v13), .iOS(.v16)],
  products: [.library(name: "PushCore", targets: ["PushCore"])],
  targets: [
    .target(name: "PushCore", path: "Sources/PushCore"),
    .testTarget(name: "PushCoreTests", dependencies: ["PushCore"], path: "Tests/PushCoreTests"),
  ]
)
```

`Tests/PushCoreTests/VectorTests.swift`:

```swift
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
```

`Tests/PushCoreTests/PresenterTests.swift`:

```swift
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
```

`apps/app/.gitignore` 末尾加:

```
# 原生单测的构建目录
native/ios-notify/.build/
native/ios-notify/.swiftpm/
native/android-push/build/
native/android-push/.gradle/
native/android-push/.kotlin/
```

- [ ] **Step 3: 跑测试,确认失败**

Run: `cd apps/app/native/ios-notify && swift test 2>&1 | tail -5; cd -`
Expected: 编译失败(`cannot find 'PushCrypto' in scope` 一类)。

- [ ] **Step 4: 实现 PushCore**

`Sources/PushCore/Base64URL.swift`:

```swift
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
```

`Sources/PushCore/PushCrypto.swift`:

```swift
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
```

`Sources/PushCore/PushMessage.swift`:

```swift
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
```

`Sources/PushCore/PushPresenter.swift`:

```swift
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
```

`Sources/PushCore/PushDedupe.swift`:

```swift
import CryptoKit
import Foundation

/// 与 packages/protocol 的 pushDedupeKey / makePushDedupe 同一规则(向量 dedupe.steps 钉住)。
public struct PushDedupe {
  public static let capacity = 64
  public static let ttlMs: Int64 = PushCrypto.maxAgeMs + PushCrypto.maxSkewMs
  public private(set) var entries: [String: Int64]

  public init(entries: [String: Int64] = [:]) { self.entries = entries }

  public static func key(ts: Double, ct: String) -> String {
    let hex = SHA256.hash(data: Data(ct.utf8)).map { String(format: "%02x", $0) }.joined()
    return "\(Int64(ts.rounded(.down))):\(hex.prefix(32))"
  }

  /// true = 见过(重复);false = 新的,已记下。
  public mutating func seen(_ key: String, nowMs: Int64) -> Bool {
    entries = entries.filter { nowMs - $0.value <= Self.ttlMs }
    if entries[key] != nil { return true }
    entries[key] = nowMs
    while entries.count > Self.capacity {
      guard let oldest = entries.min(by: { $0.value < $1.value || ($0.value == $1.value && $0.key < $1.key) }) else { break }
      entries.removeValue(forKey: oldest.key)
    }
    return false
  }
}
```

`Sources/PushCore/PushKeyRecord.swift`:

```swift
import Foundation

/// app 写进共享钥匙串的推送密钥记录:{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}(src/push/key-store.ts)。
public struct PushKeyRecord {
  public let key: Data
  public let lang: String?

  public static func parse(_ s: String) -> PushKeyRecord? {
    guard let d = s.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let v = PushCrypto.number(o["v"]), v.doubleValue == 1,
          let k = o["key"] as? String, let key = Base64URL.decode(k), key.count == 32 else { return nil }
    let lang = o["lang"] as? String
    return PushKeyRecord(key: key, lang: (lang == "en" || lang == "zh-Hans") ? lang : nil)
  }
}
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `cd apps/app/native/ios-notify && swift test 2>&1 | grep -E "Executed|error:" | tail -3; echo exit=${pipestatus[1]}; cd -`
Expected: `Executed 12 tests, with 0 failures`,`exit=0`。

- [ ] **Step 6: Commit**

```bash
git add apps/app/native/push-strings.json apps/app/native/ios-notify apps/app/.gitignore
git commit -m "app 推送:原生文案表 + Swift PushCore(CryptoKit),swift test 跑协议包推送向量

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Kotlin 推送核心(JVM 单测跑共享向量)

**Files:**
- Create: `apps/app/native/android-push/{settings.gradle.kts,build.gradle.kts,test.sh}`
- Create: `apps/app/native/android-push/src/main/kotlin/com/tendhearth/app/push/{Base64Url,PushCrypto,PushMessage,PushPresenter,PushDedupe,PushKeyRecord}.kt`
- Test: `apps/app/native/android-push/src/test/kotlin/com/tendhearth/app/push/{VectorTest,PresenterTest}.kt`

**Interfaces:**
- Consumes:向量(Task 2)、`native/push-strings.json`(Task 3)。
- Produces(Kotlin,包 `com.tendhearth.app.push`,Task 8 的服务直接用;只依赖 JDK + `org.json`,安卓自带 org.json):
  - `enum class PushOpenError { MALFORMED, AUTH, STALE }`;`sealed class PushOpenResult { Ok(payload: JSONObject, ct: String); Failure(error) }`
  - `PushCrypto.open(key: ByteArray, sealedJson: String, nowMs: Long)`、`PushCrypto.open(key, sealed: JSONObject, nowMs)`、`PushCrypto.deriveKey(deviceToken): ByteArray`
  - `PushMessage.parse(o: JSONObject): PushMessage?`;`.channel`(`decide` / `updates`);`.deepLink(): String`
  - `PushPresenter.lang(record: String?, systemTag: String)`、`.placeholder(lang, strings)`、`.display(m, lang, strings)`;`PushDisplay(title, body, channel, deepLink: String?, notificationId: Int)`
  - `PushDedupe(initial: Map<String, Long>)`:`seen(key, nowMs): Boolean`、`snapshot()`;`PushDedupe.key(ts: Double, ct: String)`
  - `PushKeyRecord.parse(s: String): PushKeyRecord?`(`key: ByteArray`,`lang: String?`)

- [ ] **Step 1: 构建文件**

`settings.gradle.kts`:

```kotlin
rootProject.name = "tendhearth-push-core"
```

`build.gradle.kts`(用 buildscript 直接拿 kotlin-gradle-plugin:插件标记 artifact 不在本机缓存里,这样第一次联网拉的东西最少):

```kotlin
// 只为在 JVM 上跑推送核心的单测。安卓构建不用这个文件:plugins/with-android-push.js 把 src/main/kotlin 下的源码拷进 android/app。
// org.json 的 JVM 版与安卓系统自带的是同一套 API(JSONObject / opt / getString)。
buildscript {
  repositories { mavenCentral() }
  dependencies { classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.20") }
}
apply(plugin = "org.jetbrains.kotlin.jvm")
repositories { mavenCentral() }
dependencies {
  "implementation"("org.json:json:20240303")
  "testImplementation"("junit:junit:4.12")
}
tasks.withType<Test> {
  testLogging {
    events("passed", "failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
```

`test.sh`(`chmod +x`):

```bash
#!/usr/bin/env bash
# 本机跑安卓推送核心的 JVM 单测。第一次要联网(kotlin-gradle-plugin 的少量依赖 + org.json,约 10 秒),之后可加 --offline。
# gradle 找法:$GRADLE → PATH 上的 gradle → ~/.gradle 里缓存的 9.1.0 发行版。JDK 默认 Homebrew 的 openjdk@21。
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
G="${GRADLE:-}"
if [ -z "$G" ]; then G="$(command -v gradle || true)"; fi
if [ -z "$G" ]; then G="$(ls -d "$HOME"/.gradle/wrapper/dists/gradle-9.1.0-all/*/gradle-9.1.0/bin/gradle 2>/dev/null | head -1 || true)"; fi
if [ -z "$G" ]; then echo "找不到 gradle:brew install gradle,或设 GRADLE=/path/to/bin/gradle" >&2; exit 2; fi
exec "$G" --no-daemon test "$@"
```

- [ ] **Step 2: 写失败的测试**

`src/test/kotlin/com/tendhearth/app/push/VectorTest.kt`:

```kotlin
package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/** 仓库根:从 Gradle 的工作目录(native/android-push)往上找 packages/protocol/vectors/push.json。 */
val repoRoot: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
  .first { File(it, "packages/protocol/vectors/push.json").exists() }

fun loadJson(rel: String) = JSONObject(File(repoRoot, rel).readText())
fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

class VectorTest {
  private val v = loadJson("packages/protocol/vectors/push.json")

  @Test fun deriveKeyMatchesRegressionVector() {
    assertEquals(v.getString("key"), b64u(PushCrypto.deriveKey(v.getString("deviceToken"))))
  }

  @Test fun everyCase() {
    val key = PushCrypto.deriveKey(v.getString("deviceToken"))
    val wrong = PushCrypto.deriveKey(v.getString("deviceToken") + "x")
    val cases = v.getJSONArray("cases")
    assertTrue(cases.length() >= 8)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val k = if (c.optBoolean("wrongKey")) wrong else key
      // FCM 的 data.wcc 是 JSON 字符串:按线上形状传字符串。
      val r = PushCrypto.open(k, c.getJSONObject("sealed").toString(), c.getLong("now"))
      when (c.getString("expect")) {
        "ok" -> {
          assertTrue(name, r is PushOpenResult.Ok)
          val ok = r as PushOpenResult.Ok
          val got = PushMessage.parse(ok.payload)
          assertNotNull(name, got)
          assertEquals(name, PushMessage.parse(c.getJSONObject("payload")), got)
          assertEquals(name, c.getString("dedupeKey"), PushDedupe.key(got!!.ts, ok.ct))
        }
        "invalid" -> {
          assertTrue(name, r is PushOpenResult.Ok)
          assertNull(name, PushMessage.parse((r as PushOpenResult.Ok).payload))
        }
        "stale" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.STALE), r)
        "auth" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.AUTH), r)
        "malformed" -> assertEquals(name, PushOpenResult.Failure(PushOpenError.MALFORMED), r)
        else -> throw AssertionError("unknown expect in $name")
      }
    }
  }

  @Test fun dedupeSteps() {
    val d = v.getJSONObject("dedupe")
    assertEquals(PushDedupe.CAPACITY, d.getInt("capacity"))
    assertEquals(PushDedupe.TTL_MS, d.getLong("ttlMs"))
    val store = PushDedupe()
    val steps = d.getJSONArray("steps")
    for (i in 0 until steps.length()) {
      val s = steps.getJSONObject(i)
      val dup = store.seen(s.getString("key"), s.getLong("now"))
      assertEquals(s.getString("note"), s.getString("expect"), if (dup) "duplicate" else "new")
    }
  }

  @Test fun dedupeEvictsOldestWhenFull() {
    val store = PushDedupe()
    for (i in 0 until PushDedupe.CAPACITY) store.seen("k%03d".format(i), 1000L + i)
    assertFalse(store.seen("new", 5000))
    assertEquals(PushDedupe.CAPACITY, store.snapshot().size)
    assertNull(store.snapshot()["k000"])
    assertTrue(store.seen("k001", 5001))
  }

  @Test fun malformedShapes() {
    val key = PushCrypto.deriveKey("t")
    val m = PushOpenResult.Failure(PushOpenError.MALFORMED)
    assertEquals(m, PushCrypto.open(key, "not json", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":true,"iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":1,"iv":"!!","ct":"AAAA"}""", 0))
    assertEquals(m, PushCrypto.open(key, """{"v":1,"iv":"AAECAwQFBgcICQoL","ct":"AAAA"}""", 0))
  }
}
```

`src/test/kotlin/com/tendhearth/app/push/PresenterTest.kt`:

```kotlin
package com.tendhearth.app.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresenterTest {
  private val strings: Map<String, Map<String, String>> = loadJson("apps/app/native/push-strings.json").let { o ->
    o.keySet().associateWith { lang -> o.getJSONObject(lang).let { t -> t.keySet().associateWith { t.getString(it) } } }
  }
  private fun okMessage(): PushMessage {
    val cases = loadJson("packages/protocol/vectors/push.json").getJSONArray("cases")
    val ok = (0 until cases.length()).map { cases.getJSONObject(it) }.first { it.getString("name") == "ok" }
    return PushMessage.parse(ok.getJSONObject("payload"))!!
  }

  @Test fun bothLanguagesHaveTheSameKeys() {
    assertEquals(strings.getValue("en").keys, strings.getValue("zh-Hans").keys)
  }

  @Test fun permissionLocalisedByKindBodyPassesThrough() {
    val m = okMessage()
    val zh = PushPresenter.display(m, "zh-Hans", strings)
    assertEquals("需要你批准", zh.title)
    assertEquals(m.body, zh.body)
    assertEquals("decide", zh.channel)
    assertEquals("tendhearth://push-open?kind=permission&taskId=t-42&requestId=r-7", zh.deepLink)
    assertEquals("t-42".hashCode(), zh.notificationId)
    assertEquals("Needs your approval", PushPresenter.display(m, "en", strings).title)
  }

  @Test fun testKindAndPlaceholder() {
    val t = PushMessage(1.0, "test", "CC", "这是一条测试通知", null, null)
    val d = PushPresenter.display(t, "en", strings)
    assertEquals("Notifications reach this phone.", d.body)
    assertEquals("updates", d.channel)
    assertEquals("tendhearth://push-open?kind=test", d.deepLink)
    val p = PushPresenter.placeholder("zh-Hans", strings)
    assertEquals("CC 有新动态", p.body)
    assertNull(p.deepLink)
  }

  @Test fun languagePick() {
    assertEquals("zh-Hans", PushPresenter.lang("zh-Hans", "en-GB"))
    assertEquals("zh-Hans", PushPresenter.lang(null, "zh-Hant-TW"))
    assertEquals("en", PushPresenter.lang(null, "en-GB"))
    assertEquals("en", PushPresenter.lang("fr", "fr-FR"))
  }

  @Test fun deepLinkEncodesValues() {
    val m = PushMessage(1.0, "question", "t", "b", "ab12cd34", "q 1&x")
    assertEquals("tendhearth://push-open?kind=question&taskId=ab12cd34&requestId=q+1%26x", m.deepLink())
  }

  @Test fun messageParseMatchesZodShape() {
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"approval_needed","title":"t","body":"b"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":"x","kind":"test","title":"t","body":"b"}""")))
    assertNull(PushMessage.parse(JSONObject("""{"ts":1,"kind":"test","title":"t","body":"b","taskId":null}""")))
  }

  @Test fun keyRecord() {
    val v = loadJson("packages/protocol/vectors/push.json")
    val rec = PushKeyRecord.parse("""{"v":1,"key":"${v.getString("key")}","lang":"zh-Hans"}""")!!
    assertEquals(b64u(PushCrypto.deriveKey(v.getString("deviceToken"))), b64u(rec.key))
    assertEquals("zh-Hans", rec.lang)
    assertNull(PushKeyRecord.parse("""{"v":1,"key":"AAAA","lang":null}"""))
    assertNull(PushKeyRecord.parse("not json"))
    assertNull(PushKeyRecord.parse("""{"v":1,"key":"${v.getString("key")}","lang":"fr"}""")!!.lang)
  }
}
```

- [ ] **Step 3: 跑测试,确认失败**

Run: `apps/app/native/android-push/test.sh 2>&1 | tail -5`
Expected: 编译失败(`Unresolved reference 'PushCrypto'`)。第一次运行会联网下载依赖。

- [ ] **Step 4: 实现**

`src/main/kotlin/com/tendhearth/app/push/Base64Url.kt`:

```kotlin
package com.tendhearth.app.push

import java.io.ByteArrayOutputStream

/** 与 packages/protocol/src/b64u.ts 同一规则:容忍尾部 `=`;长度模 4 余 1 或有非法字符 ⇒ null。不用 java.util.Base64(安卓 26 以下没有)。 */
object Base64Url {
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  fun decode(s: String): ByteArray? {
    val clean = s.trimEnd('=')
    if (clean.length % 4 == 1) return null
    val out = ByteArrayOutputStream(clean.length * 3 / 4)
    var buffer = 0
    var bits = 0
    for (ch in clean) {
      val v = ALPHABET.indexOf(ch)
      if (v < 0) return null
      buffer = (buffer shl 6) or v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((buffer shr bits) and 0xff)
      }
    }
    return out.toByteArray()
  }
}
```

`PushCrypto.kt`:

```kotlin
package com.tendhearth.app.push

import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class PushOpenError { MALFORMED, AUTH, STALE }

sealed class PushOpenResult {
  data class Ok(val payload: JSONObject, val ct: String) : PushOpenResult()
  data class Failure(val error: PushOpenError) : PushOpenResult()
}

/**
 * 与 packages/protocol/src/push.ts 的 derivePushKey / openPush 同一算法、同一拒绝顺序:
 * 形状 → base64 → GCM 认证 → 明文是 JSON 对象 → ts 是有限数字 → 时间窗(过去 1 小时 / 未来 10 分钟)。
 */
object PushCrypto {
  const val MAX_AGE_MS = 3_600_000L
  const val MAX_SKEW_MS = 600_000L
  private val INFO = "wechat-cc/push/v1".toByteArray(Charsets.UTF_8)

  /** HKDF-SHA256(ikm = utf8(deviceToken), salt = 空, info)。空盐按 RFC 5869 等价于 32 个 0 字节(javax 的 HmacSHA256 不收空钥匙)。服务本身不调用,给向量核对。 */
  fun deriveKey(deviceToken: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
    val prk = mac.doFinal(deviceToken.toByteArray(Charsets.UTF_8))
    mac.init(SecretKeySpec(prk, "HmacSHA256"))
    mac.update(INFO)
    mac.update(1.toByte())
    return mac.doFinal() // 32 字节正好是 T(1)
  }

  fun open(key: ByteArray, sealedJson: String, nowMs: Long): PushOpenResult {
    val sealed = try { JSONObject(sealedJson) } catch (e: Exception) { return fail(PushOpenError.MALFORMED) }
    return open(key, sealed, nowMs)
  }

  fun open(key: ByteArray, sealed: JSONObject, nowMs: Long): PushOpenResult {
    val v = sealed.opt("v")
    if (v !is Number || v.toDouble() != 1.0) return fail(PushOpenError.MALFORMED)
    val ivS = sealed.opt("iv") as? String ?: return fail(PushOpenError.MALFORMED)
    val ctS = sealed.opt("ct") as? String ?: return fail(PushOpenError.MALFORMED)
    val iv = Base64Url.decode(ivS) ?: return fail(PushOpenError.MALFORMED)
    val ct = Base64Url.decode(ctS) ?: return fail(PushOpenError.MALFORMED)
    if (iv.size != 12 || ct.size < 16) return fail(PushOpenError.MALFORMED)
    val plain = try {
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
      c.doFinal(ct)
    } catch (e: Exception) {
      return fail(PushOpenError.AUTH)
    }
    val payload = try { JSONObject(String(plain, Charsets.UTF_8)) } catch (e: Exception) { return fail(PushOpenError.MALFORMED) }
    val ts = payload.opt("ts") as? Number ?: return fail(PushOpenError.MALFORMED)
    val t = ts.toDouble()
    if (!t.isFinite()) return fail(PushOpenError.MALFORMED)
    if (t < (nowMs - MAX_AGE_MS).toDouble() || t > (nowMs + MAX_SKEW_MS).toDouble()) return fail(PushOpenError.STALE)
    return PushOpenResult.Ok(payload, ctS)
  }

  private fun fail(e: PushOpenError) = PushOpenResult.Failure(e)
}
```

`PushMessage.kt`:

```kotlin
package com.tendhearth.app.push

import org.json.JSONObject
import java.net.URLEncoder

/** 与 packages/protocol 的 PushPlaintext(zod)同一形状:多余字段忽略;可选字段出现就必须是字符串(JSON null 也拒)。 */
data class PushMessage(val ts: Double, val kind: String, val title: String, val body: String, val taskId: String?, val requestId: String?) {
  /** 安卓通知渠道:需要你决定(批准 / 问题)与 完成与失败(其余)。 */
  val channel: String get() = if (kind == "permission" || kind == "question") "decide" else "updates"

  /** 点通知的深链,交给 app 的 src/app/push-open.tsx(参数在那边校验)。 */
  fun deepLink(): String {
    val q = mutableListOf("kind" to kind)
    taskId?.let { q.add("taskId" to it) }
    requestId?.let { q.add("requestId" to it) }
    return "tendhearth://push-open?" + q.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
  }

  companion object {
    val KINDS = setOf("permission", "question", "task_done", "task_failed", "test")

    fun parse(o: JSONObject): PushMessage? {
      val ts = o.opt("ts") as? Number ?: return null
      val kind = o.opt("kind") as? String ?: return null
      if (kind !in KINDS) return null
      val title = o.opt("title") as? String ?: return null
      val body = o.opt("body") as? String ?: return null
      val taskId = o.opt("taskId")
      if (taskId != null && taskId !is String) return null
      val requestId = o.opt("requestId")
      if (requestId != null && requestId !is String) return null
      return PushMessage(ts.toDouble(), kind, title, body, taskId as String?, requestId as String?)
    }
  }
}
```

`PushPresenter.kt`:

```kotlin
package com.tendhearth.app.push

data class PushDisplay(val title: String, val body: String, val channel: String, val deepLink: String?, val notificationId: Int)

object PushPresenter {
  /** 占位通知的固定 id:连着几条解不开的只留一条。 */
  const val PLACEHOLDER_ID = 0x7e4d

  /** 钥匙串记录里的语言优先;否则系统语言以 zh 开头 ⇒ zh-Hans,其余 en(同 src/i18n pickLang)。 */
  fun lang(record: String?, systemTag: String): String = when {
    record == "en" || record == "zh-Hans" -> record
    systemTag.lowercase().startsWith("zh") -> "zh-Hans"
    else -> "en"
  }

  private fun s(strings: Map<String, Map<String, String>>, lang: String, key: String): String =
    strings[lang]?.get(key) ?: strings["en"]?.get(key) ?: key

  fun placeholder(lang: String, strings: Map<String, Map<String, String>>) =
    PushDisplay(s(strings, lang, "placeholder.title"), s(strings, lang, "placeholder.body"), "updates", null, PLACEHOLDER_ID)

  /** 标题按 kind 本地化;正文是用户自己的数据原样显示;test 的正文也本地化。同一件事的通知用同一个 id(与 APNs collapse-id 一样只留最新一条)。 */
  fun display(m: PushMessage, lang: String, strings: Map<String, Map<String, String>>) = PushDisplay(
    title = s(strings, lang, "title.${m.kind}"),
    body = if (m.kind == "test") s(strings, lang, "body.test") else m.body,
    channel = m.channel,
    deepLink = m.deepLink(),
    notificationId = (m.taskId ?: m.kind).hashCode(),
  )
}
```

`PushDedupe.kt`:

```kotlin
package com.tendhearth.app.push

import java.security.MessageDigest
import kotlin.math.floor

/** 与 packages/protocol 的 pushDedupeKey / makePushDedupe 同一规则(向量 dedupe.steps 钉住)。 */
class PushDedupe(initial: Map<String, Long> = emptyMap()) {
  private val entries = LinkedHashMap(initial)

  fun snapshot(): Map<String, Long> = HashMap(entries)

  /** true = 见过(重复,不再提醒);false = 新的,已记下。 */
  fun seen(key: String, nowMs: Long): Boolean {
    entries.entries.removeAll { nowMs - it.value > TTL_MS }
    if (entries.containsKey(key)) return true
    entries[key] = nowMs
    while (entries.size > CAPACITY) {
      val oldest = entries.entries.minWith(compareBy<Map.Entry<String, Long>> { it.value }.thenBy { it.key }).key
      entries.remove(oldest)
    }
    return false
  }

  companion object {
    const val CAPACITY = 64
    const val TTL_MS = PushCrypto.MAX_AGE_MS + PushCrypto.MAX_SKEW_MS

    fun key(ts: Double, ct: String): String {
      val d = MessageDigest.getInstance("SHA-256").digest(ct.toByteArray(Charsets.UTF_8))
      val hex = d.joinToString("") { "%02x".format(it) }
      return "${floor(ts).toLong()}:${hex.take(32)}"
    }
  }
}
```

`PushKeyRecord.kt`:

```kotlin
package com.tendhearth.app.push

import org.json.JSONObject

/** app 写进 expo-secure-store 的推送密钥记录:{"v":1,"key":"<base64url 32 字节>","lang":"en"|"zh-Hans"|null}(src/push/key-store.ts)。 */
class PushKeyRecord(val key: ByteArray, val lang: String?) {
  companion object {
    fun parse(s: String): PushKeyRecord? = try {
      val o = JSONObject(s)
      val v = o.opt("v")
      val key = (o.opt("key") as? String)?.let { Base64Url.decode(it) }
      if (v !is Number || v.toDouble() != 1.0 || key == null || key.size != 32) null
      else PushKeyRecord(key, (o.opt("lang") as? String)?.takeIf { it == "en" || it == "zh-Hans" })
    } catch (e: Exception) {
      null
    }
  }
}
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `apps/app/native/android-push/test.sh 2>&1 | grep -E "PASSED|FAILED|BUILD" | tail -15; echo exit=${pipestatus[1]}`
Expected: 12 条 `PASSED`,`BUILD SUCCESSFUL`,`exit=0`。再跑一次 `apps/app/native/android-push/test.sh --offline`,Expected 同样通过(证明之后不用联网)。

- [ ] **Step 6: Commit**

```bash
chmod +x apps/app/native/android-push/test.sh
git add apps/app/native/android-push
git commit -m "app 推送:Kotlin 推送核心(JDK + org.json),JVM 单测跑协议包推送向量

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: app 纯逻辑 —— 推送密钥记录、登记流程、Backend 的登记 / 测试接口

**Files:**
- Create: `apps/app/src/push/key-store.ts`、`apps/app/src/push/register.ts`、`apps/app/src/push/mem-secure-store.ts`(测试辅助)
- Modify: `apps/app/src/backend/types.ts`、`apps/app/src/backend/live.ts`、`apps/app/src/backend/demo.ts`、`apps/app/src/net/errors.ts`
- Test: `apps/app/src/push/key-store.test.ts`、`apps/app/src/push/register.test.ts`、`apps/app/src/net/errors.test.ts`、`apps/app/src/backend/live.test.ts`
- Test(根):`src/daemon/phone-app-push-e2e.test.ts`(新)、`src/daemon/phone-app-live-e2e.test.ts`

**Interfaces:**
- Consumes:`derivePushKey`、`b64uEncode`、`pushTokenValid`、`PushPlatformT`、`openPush`、`PushPlaintext`(协议包);`SecureStoreLike`(`src/net/credentials.ts`);`BackendError`(`src/backend/types.ts`)。
- Produces:
  - `key-store.ts`:`PUSH_KEY_ITEM = 'tendhearth.pushkey.v1'`、`PUSH_KEY_SERVICE = 'tendhearth.push'`、`PUSH_REG_ITEM = 'tendhearth.pushreg.v1'`;`type PushKeyRecord = { v: 1; key: string; lang: Lang | null }`;`type PushReg = { fp: string; at: number }`;`pushKeyRecord(deviceToken, lang): PushKeyRecord`;`isDevPushToken(s): boolean`(`/^dev[0-9a-f]{48}$/`);`interface PushKeyStore { ensure(deviceToken: string, lang: Lang | null): Promise<void>; loadReg(): Promise<PushReg | null>; saveReg(r: PushReg): Promise<void>; clear(): Promise<void> }`;`makePushKeyStore(ss: SecureStoreLike, opts: { shared: Record<string, unknown>; local: Record<string, unknown> }): PushKeyStore`
  - `register.ts`:`type PermissionState = 'granted' | 'denied' | 'undetermined'`;`type PushStatus = 'idle' | 'registered' | 'denied' | 'unavailable' | 'offline' | 'failed'`;`type PushDeps`(见下);`REREGISTER_MS = 86_400_000`;`platformFor(os, apnsEnv): PushPlatformT`;`permState(p): PermissionState`;`shouldSync(status, trigger: 'online' | 'foreground' | 'token'): boolean`;`syncPush(d: PushDeps, opts?: { force?: boolean }): Promise<PushStatus>`
  - `Backend.registerPush(platform: PushPlatformT, token: string): Promise<void>`、`Backend.testPush(): Promise<{ ok: boolean; code: string }>`;`BackendCode` 增加 `'unavailable'`;`mapPhoneError`:`push_not_wired` ⇒ `'unavailable'`
  - 演示后端:`matter()` / 其余按 id 取的读,找不到 ⇒ `BackendError('not_found')`(原来是 `unknown`,与真后端对齐,Task 6 的中转页靠它)

- [ ] **Step 1: 写失败的测试**

测试用的内存钥匙串 `apps/app/src/push/mem-secure-store.ts`(单独一个文件:测试文件互相 import 会让用例跑两遍):

```ts
import { vi } from 'vitest'

/** 内存版 expo-secure-store:按 keychainService 分开存(与真实现一样,service 不同就是两条)。只给测试用。 */
export function memSecureStore() {
  const m = new Map<string, string>()
  const k = (key: string, o?: { keychainService?: string }) => `${o?.keychainService ?? 'app'}/${key}`
  const ss = {
    getItemAsync: vi.fn(async (key: string, o?: { keychainService?: string }) => m.get(k(key, o)) ?? null),
    setItemAsync: vi.fn(async (key: string, v: string, o?: { keychainService?: string }) => { m.set(k(key, o), v) }),
    deleteItemAsync: vi.fn(async (key: string, o?: { keychainService?: string }) => { m.delete(k(key, o)) }),
  }
  return { m, ss }
}
```

`apps/app/src/push/key-store.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { b64uEncode, derivePushKey } from '@wechat-cc/protocol'
import { makePushKeyStore, pushKeyRecord, isDevPushToken, PUSH_KEY_ITEM, PUSH_KEY_SERVICE, PUSH_REG_ITEM } from './key-store'
import { memSecureStore } from './mem-secure-store'

const TOKEN = 'd' + 'ab'.repeat(24)
const SHARED = { keychainService: PUSH_KEY_SERVICE, accessGroup: 'TEAM.com.tendhearth.app.shared' }

describe('推送密钥记录(扩展 / 服务只拿到它,拿不到设备令牌)', () => {
  it('pushKeyRecord:key = base64url(derivePushKey(设备令牌)),lang 原样', () => {
    expect(pushKeyRecord(TOKEN, 'zh-Hans')).toEqual({ v: 1, key: b64uEncode(derivePushKey(TOKEN)), lang: 'zh-Hans' })
  })
  it('与协议包回归向量一致', () => {
    const v = JSON.parse(readFileSync(new URL('../../../../packages/protocol/vectors/push.json', import.meta.url), 'utf8'))
    expect(pushKeyRecord(v.deviceToken, null).key).toBe(v.key)
  })
  it('ensure 只写进共享那组选项;内容没变不重写;语言变了才重写', async () => {
    const { m, ss } = memSecureStore()
    const s = makePushKeyStore(ss, { shared: SHARED, local: {} })
    await s.ensure(TOKEN, null)
    await s.ensure(TOKEN, null)
    expect(ss.setItemAsync).toHaveBeenCalledTimes(1)
    expect(ss.setItemAsync.mock.calls[0]![0]).toBe(PUSH_KEY_ITEM)
    expect(ss.setItemAsync.mock.calls[0]![2]).toEqual(SHARED)
    expect(JSON.parse(m.get(`${PUSH_KEY_SERVICE}/${PUSH_KEY_ITEM}`)!)).toEqual(pushKeyRecord(TOKEN, null))
    await s.ensure(TOKEN, 'en')
    expect(ss.setItemAsync).toHaveBeenCalledTimes(2)
    expect([...m.values()].join()).not.toContain(TOKEN)          // 设备令牌本身从不写进这里
  })
  it('登记指纹走本地选项;clear 两条都删', async () => {
    const { m, ss } = memSecureStore()
    const s = makePushKeyStore(ss, { shared: SHARED, local: {} })
    await s.ensure(TOKEN, null)
    await s.saveReg({ fp: 'x', at: 1 })
    expect(m.get(`app/${PUSH_REG_ITEM}`)).toBe('{"fp":"x","at":1}')
    expect(await s.loadReg()).toEqual({ fp: 'x', at: 1 })
    await s.clear()
    expect(m.size).toBe(0)
  })
  it('登记指纹读出来不合形状 ⇒ 当没有', async () => {
    const { m, ss } = memSecureStore()
    m.set(`app/${PUSH_REG_ITEM}`, '{"fp":1}')
    expect(await makePushKeyStore(ss, { shared: SHARED, local: {} }).loadReg()).toBeNull()
  })
  it('isDevPushToken:只认 dev + 48 位 hex,真设备令牌(d…)不算', () => {
    expect(isDevPushToken('dev' + 'a'.repeat(48))).toBe(true)
    expect(isDevPushToken(TOKEN)).toBe(false)
    expect(isDevPushToken('dev' + 'a'.repeat(47))).toBe(false)
  })
})
```

`apps/app/src/push/register.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { makePushKeyStore, PUSH_KEY_SERVICE } from './key-store'
import { memSecureStore } from './mem-secure-store'
import { syncPush, platformFor, permState, shouldSync, REREGISTER_MS, type PushDeps } from './register'

const TOKEN = 'd' + 'ab'.repeat(24)
const APNS = 'a1'.repeat(32)

function harness(over: Partial<PushDeps> = {}) {
  const { m, ss } = memSecureStore()
  const logs: string[] = []
  let now = 1_000_000
  const order: string[] = []
  const register = vi.fn(async () => { order.push('register') })
  const requestPermission = vi.fn(async () => { order.push('request'); return 'granted' as const })
  const keys = makePushKeyStore(ss, { shared: { keychainService: PUSH_KEY_SERVICE }, local: {} })
  const ensure = keys.ensure
  keys.ensure = async (t, l) => { order.push('ensure'); return ensure(t, l) }
  const d: PushDeps = {
    os: 'ios', apnsEnv: 'development', deviceId: 'ab12cd34', deviceToken: TOKEN, lang: null, keys,
    permission: async () => 'granted', requestPermission, nativeToken: async () => APNS, register,
    now: () => now, log: l => logs.push(l), ...over,
  }
  return { d, m, logs, register, requestPermission, order, tick: (ms: number) => { now += ms } }
}

describe('syncPush —— 配对后 / 启动 / token 刷新 / 回前台都走这一个', () => {
  it('已授权:先存推送密钥,再拿 token,登记 apns_sandbox;记下指纹', async () => {
    const h = harness()
    expect(await syncPush(h.d)).toBe('registered')
    expect(h.register).toHaveBeenCalledWith('apns_sandbox', APNS)
    expect(h.order[0]).toBe('ensure')
    expect(await h.d.keys.loadReg()).toEqual({ fp: `ab12cd34|apns_sandbox|${APNS}`, at: 1_000_000 })
  })
  it('24 小时内同一 token ⇒ 不再登记;过了 24 小时 / force / token 变了 ⇒ 再登记', async () => {
    const h = harness()
    await syncPush(h.d)
    expect(await syncPush(h.d)).toBe('registered')
    expect(h.register).toHaveBeenCalledTimes(1)
    await syncPush(h.d, { force: true })
    expect(h.register).toHaveBeenCalledTimes(2)
    h.tick(REREGISTER_MS)
    await syncPush(h.d)
    expect(h.register).toHaveBeenCalledTimes(3)
    await syncPush({ ...h.d, nativeToken: async () => 'b2'.repeat(32) })
    expect(h.register).toHaveBeenCalledTimes(4)
  })
  it('没问过权限 ⇒ 先 prepare(安卓建渠道)再弹系统框;拒了 ⇒ denied,不登记,但推送密钥已存', async () => {
    const prepare = vi.fn(async () => {})
    const h = harness({ permission: async () => 'undetermined', requestPermission: vi.fn(async () => 'denied' as const), prepare })
    expect(await syncPush(h.d)).toBe('denied')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.register).not.toHaveBeenCalled()
    expect(h.m.size).toBe(1)
  })
  it('早就拒过 ⇒ 不再弹框,直接 denied', async () => {
    const h = harness({ permission: async () => 'denied' })
    expect(await syncPush(h.d)).toBe('denied')
    expect(h.requestPermission).not.toHaveBeenCalled()
  })
  it('拿不到原生 token(模拟器没有 FCM / 没有 google-services)⇒ unavailable', async () => {
    const h = harness({ nativeToken: async () => { throw new Error('no firebase') } })
    expect(await syncPush(h.d)).toBe('unavailable')
  })
  it('token 形状不对 ⇒ failed,不发请求', async () => {
    const h = harness({ nativeToken: async () => 'xyz' })
    expect(await syncPush(h.d)).toBe('failed')
    expect(h.register).not.toHaveBeenCalled()
  })
  it('daemon 没接推送(还在老中继)⇒ unavailable;离线 / 超时 ⇒ offline;撤销等其余 ⇒ failed;都不记指纹', async () => {
    for (const [code, want] of [['unavailable', 'unavailable'], ['offline', 'offline'], ['timeout', 'offline'], ['revoked', 'failed'], ['invalid', 'failed']] as const) {
      const h = harness({ register: vi.fn(async () => { throw new BackendError(code) }) })
      expect(await syncPush(h.d), code).toBe(want)
      expect(await h.d.keys.loadReg(), code).toBeNull()
    }
  })
  it('日志里从不出现设备令牌、推送密钥、APNs token', async () => {
    const h = harness({ register: vi.fn(async () => { throw new BackendError('offline') }) })
    await syncPush(h.d)
    await syncPush({ ...h.d, nativeToken: async () => 'xyz' })
    await syncPush({ ...h.d, nativeToken: async () => { throw new Error(`boom ${APNS}`) } })
    const all = h.logs.join('\n')
    expect(all.length).toBeGreaterThan(0)
    for (const secret of [TOKEN, APNS, JSON.parse([...h.m.values()][0]!).key]) expect(all).not.toContain(secret)
  })
})

describe('小函数', () => {
  it('platformFor:iOS 开发构建 ⇒ apns_sandbox;TestFlight / 商店 ⇒ apns;安卓 ⇒ fcm', () => {
    expect(platformFor('ios', 'development')).toBe('apns_sandbox')
    expect(platformFor('ios', 'production')).toBe('apns')
    expect(platformFor('android', 'production')).toBe('fcm')
  })
  it('permState:granted / iOS 临时授权(provisional=3、ephemeral=4)都算允许;undetermined;其余 denied', () => {
    expect(permState({ status: 'granted', granted: true })).toBe('granted')
    expect(permState({ status: 'denied', granted: false, ios: { status: 3 } })).toBe('granted')
    expect(permState({ status: 'undetermined', granted: false })).toBe('undetermined')
    expect(permState({ status: 'denied', granted: false })).toBe('denied')
  })
  it('shouldSync:token 变了总是;上线 / 回前台只在还没登记成功时', () => {
    expect(shouldSync('registered', 'token')).toBe(true)
    expect(shouldSync('registered', 'online')).toBe(false)
    expect(shouldSync('registered', 'foreground')).toBe(false)
    for (const s of ['idle', 'denied', 'unavailable', 'offline', 'failed'] as const) {
      expect(shouldSync(s, 'online'), s).toBe(true)
      expect(shouldSync(s, 'foreground'), s).toBe(true)
    }
  })
})
```

`apps/app/src/net/errors.test.ts` 追加:

```ts
  it('daemon 没接推送(push_not_wired,503)⇒ unavailable', () => {
    expect(mapPhoneError(503, { ok: false, error: 'push_not_wired' })).toBe('unavailable')
  })
```

`apps/app/src/backend/live.test.ts` 追加(沿用文件里的 `harness(routes)` 与 `ok(json, status)`):

```ts
describe('推送登记 / 测试通知', () => {
  it('registerPush 发 POST /m/api/push/register {platform, token};testPush 返回 daemon 的结果', async () => {
    const { b, reqs, logs } = harness({
      'POST /m/api/push/register': ok({ ok: true }),
      'POST /m/api/push/test': ok({ ok: true, result: { ok: false, code: 'relay_offline' } }),
    })
    await b.registerPush('apns_sandbox', 'a1'.repeat(32))
    expect(reqs.find(r => r.key === 'POST /m/api/push/register')?.body).toEqual({ platform: 'apns_sandbox', token: 'a1'.repeat(32) })
    expect(await b.testPush()).toEqual({ ok: false, code: 'relay_offline' })
    expect(logs.join('\n')).not.toContain('a1'.repeat(32))
  })
  it('daemon 没接推送 ⇒ BackendError(unavailable)', async () => {
    const { b } = harness({ 'POST /m/api/push/register': ok({ ok: false, error: 'push_not_wired' }, 503) })
    await expect(b.registerPush('fcm', 'x'.repeat(40))).rejects.toMatchObject({ code: 'unavailable' })
  })
})
```

根目录 `src/daemon/phone-app-push-e2e.test.ts`(新):

```ts
/**
 * daemon 真 makePhonePush 封的推送 ↔ 手机 app 推出的推送密钥:两边对得上(spec §7、§9.3)。
 * 不起中继:send 直接收下 daemon 要发给房间的控制消息。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { b64uDecode, openPush, PushPlaintext, type SealedPush } from '@wechat-cc/protocol'
import { makePhonePush } from './phone-push'
import { pushKeyRecord } from '../../apps/app/src/push/key-store'
import { targetFromParams, targetFromPlaintext } from '../../apps/app/src/push/target'
import { pushOpenHref } from '../../apps/app/src/push/route'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('daemon 推送 → app 解开 → 路由', () => {
  it('permission 推送:app 用设备令牌推出的密钥解开,明文过 PushPlaintext,点开定位到那条请求', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-push-e2e-'))
    dirs.push(dir)
    const token = 'd' + '0f'.repeat(24)
    const sent: Array<Record<string, unknown>> = []
    const push = makePhonePush({ stateDir: dir, send: m => { sent.push(m as Record<string, unknown>); return true }, deviceToken: () => token, deviceIds: () => ['ab12cd34'], log: () => {} })
    expect(push.register('ab12cd34', 'apns_sandbox', 'a1'.repeat(32))).toBe(true)
    expect(push.notify('ab12cd34', { kind: 'permission', title: '需要你批准', body: '整理作品集:npm i sharp', taskId: 'ab12cd34', requestId: 'perm-1' })).toBe(true)
    const msg = sent.find(m => 'push' in m) as { push: { sealed: SealedPush; collapseId: string } }
    expect(msg.push.collapseId).toBe('ab12cd34')
    const key = b64uDecode(pushKeyRecord(token, null).key)
    const plain = PushPlaintext.parse(openPush(key, msg.push.sealed, Date.now()))
    expect(plain).toMatchObject({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' })
    const target = targetFromPlaintext(plain)
    expect(target).toEqual({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' })
    const href = pushOpenHref(target!)
    const params = Object.fromEntries(new URLSearchParams(href.split('?')[1]))
    expect(targetFromParams(params)).toEqual(target)
  })
})
```

(`targetFromParams` / `targetFromPlaintext` / `pushOpenHref` 在 Task 6 才有。**本任务先写一个占位版本**:文件头注释 + `import { describe, it } from 'vitest'` + `describe('daemon 推送 → app 解开 → 路由', () => { it.todo('permission 推送:app 用设备令牌推出的密钥解开,明文过 PushPlaintext,点开定位到那条请求') })`,不 import 任何 app 文件;Task 6 Step 3 把整个文件换成上面的完整版本。)

`src/daemon/phone-app-live-e2e.test.ts` 的 describe 里追加:

```ts
  it('这台 daemon 没接推送(还没上 v2 中继)⇒ registerPush 报 unavailable(不是 unknown / revoked),连接照常 online', async () => {
    const b = live()
    await expect(b.registerPush('apns_sandbox', 'a1'.repeat(32))).rejects.toMatchObject({ code: 'unavailable' })
    await expect.poll(() => b.connection().state, P).toBe('online')
  })
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -15; cd ../..`
Expected: FAIL(`./key-store`、`./register` 不存在;`registerPush` 不是函数;`mapPhoneError` 返回 `unknown`)。

- [ ] **Step 3: 实现**

`apps/app/src/push/key-store.ts`:

```ts
import { b64uEncode, derivePushKey } from '@wechat-cc/protocol'
import type { Lang } from '../i18n'
import type { SecureStoreLike } from '../net/credentials'

/**
 * 推送密钥记录(spec §4「身份与存储」):扩展 / 消息服务只读这一条,读不到设备令牌。
 * iOS:service `tendhearth.push`、access group 与通知扩展共享;安卓:同一份 expo-secure-store,Kotlin 按它的存储格式直接读
 * (plugins/native-guards.test.ts 钉住那两种格式)。改键名、改 service、改格式 ⇒ 同时改 native/ 两端。
 */
export const PUSH_KEY_ITEM = 'tendhearth.pushkey.v1'
export const PUSH_KEY_SERVICE = 'tendhearth.push'
/** 上次登记成功的指纹(设备 id + 平台 + token)与时间;本地,不共享。 */
export const PUSH_REG_ITEM = 'tendhearth.pushreg.v1'

export type PushKeyRecord = { v: 1; key: string; lang: Lang | null }
export type PushReg = { fp: string; at: number }

export interface PushKeyStore {
  /** 从设备令牌推出推送密钥,连同语言写进共享钥匙串;内容没变就不写。 */
  ensure(deviceToken: string, lang: Lang | null): Promise<void>
  loadReg(): Promise<PushReg | null>
  saveReg(r: PushReg): Promise<void>
  /** 撤销 / 解除配对:推送密钥与登记指纹都清掉。 */
  clear(): Promise<void>
}

export function pushKeyRecord(deviceToken: string, lang: Lang | null): PushKeyRecord {
  return { v: 1, key: b64uEncode(derivePushKey(deviceToken)), lang }
}

/** 只给开发构建的模拟器验证用(src/app/dev-push-key.tsx):形状与真设备令牌(d + 48 位 hex)刻意不同。 */
export function isDevPushToken(s: string): boolean {
  return /^dev[0-9a-f]{48}$/.test(s)
}

export function makePushKeyStore(ss: SecureStoreLike, opts: { shared: Record<string, unknown>; local: Record<string, unknown> }): PushKeyStore {
  return {
    async ensure(deviceToken, lang) {
      const next = JSON.stringify(pushKeyRecord(deviceToken, lang))
      const cur = await ss.getItemAsync(PUSH_KEY_ITEM, opts.shared)
      if (cur !== next) await ss.setItemAsync(PUSH_KEY_ITEM, next, opts.shared)
    },
    async loadReg() {
      const raw = await ss.getItemAsync(PUSH_REG_ITEM, opts.local)
      if (raw === null) return null
      try {
        const r = JSON.parse(raw) as { fp?: unknown; at?: unknown }
        return typeof r.fp === 'string' && typeof r.at === 'number' ? { fp: r.fp, at: r.at } : null
      } catch { return null }
    },
    saveReg: r => ss.setItemAsync(PUSH_REG_ITEM, JSON.stringify(r), opts.local),
    async clear() {
      await Promise.all([ss.deleteItemAsync(PUSH_KEY_ITEM, opts.shared), ss.deleteItemAsync(PUSH_REG_ITEM, opts.local)])
    },
  }
}
```

`apps/app/src/push/register.ts`:

```ts
import { pushTokenValid, type PushPlatformT } from '@wechat-cc/protocol'
import { BackendError } from '../backend/types'
import type { Lang } from '../i18n'
import type { PushKeyStore } from './key-store'

// 推送登记(spec §6 最后两步、§7「token 生命周期」)。纯逻辑:expo-notifications 与钥匙串由调用方注入(src/push/native.ts)。
// 日志只写步骤名与错误码 / 错误类名,从不写令牌、密钥、APNs / FCM token。

export type PermissionState = 'granted' | 'denied' | 'undetermined'
export type PushStatus = 'idle' | 'registered' | 'denied' | 'unavailable' | 'offline' | 'failed'
export type PushDeps = {
  os: 'ios' | 'android'
  apnsEnv: 'development' | 'production'
  deviceId: string
  deviceToken: string
  /** 设置里的语言覆盖(null = 跟系统);写进推送密钥记录,原生端按它选语言。 */
  lang: Lang | null
  keys: PushKeyStore
  permission(): Promise<PermissionState>
  requestPermission(): Promise<PermissionState>
  /** 安卓 13+ 要先有通知渠道,系统才肯弹权限框;iOS 不传。 */
  prepare?(): Promise<void>
  nativeToken(): Promise<string>
  register(platform: PushPlatformT, token: string): Promise<void>
  now(): number
  log(line: string): void
}

/** 同一 token 每天至少重登一次:daemon 那边的登记文件丢了 / 中继换过,都能自愈。 */
export const REREGISTER_MS = 86_400_000

export function platformFor(os: 'ios' | 'android', apnsEnv: 'development' | 'production'): PushPlatformT {
  if (os === 'android') return 'fcm'
  return apnsEnv === 'production' ? 'apns' : 'apns_sandbox'
}

/** expo-notifications 的权限结果 → 三态。iOS 的临时授权(provisional = 3、ephemeral = 4)也能收通知。 */
export function permState(p: { status: string; granted: boolean; ios?: { status?: number } }): PermissionState {
  if (p.granted) return 'granted'
  if (p.ios?.status === 3 || p.ios?.status === 4) return 'granted'
  return p.status === 'undetermined' ? 'undetermined' : 'denied'
}

/** token 变了总要重登;上线(首次连上 / 重连)与回前台(可能刚去系统设置打开了通知)只在还没登记成功时再试。 */
export function shouldSync(status: PushStatus, trigger: 'online' | 'foreground' | 'token'): boolean {
  return trigger === 'token' || status !== 'registered'
}

const errName = (e: unknown) => (e instanceof BackendError ? e.code : e instanceof Error ? e.name : 'unknown')

export async function syncPush(d: PushDeps, opts: { force?: boolean } = {}): Promise<PushStatus> {
  // 先存密钥:权限还没给、电脑还没连上时,之后到的推送扩展照样能解开。
  await d.keys.ensure(d.deviceToken, d.lang)
  let perm = await d.permission()
  if (perm === 'undetermined') {
    await d.prepare?.()
    perm = await d.requestPermission()
  }
  if (perm !== 'granted') return 'denied'
  let token: string
  try { token = await d.nativeToken() } catch (e) { d.log(`push: native token unavailable (${errName(e)})`); return 'unavailable' }
  const platform = platformFor(d.os, d.apnsEnv)
  if (!pushTokenValid(platform, token)) { d.log(`push: native token has unexpected shape (${platform})`); return 'failed' }
  const fp = `${d.deviceId}|${platform}|${token}`
  const prev = await d.keys.loadReg()
  if (!opts.force && prev && prev.fp === fp && d.now() - prev.at < REREGISTER_MS) return 'registered'
  try {
    await d.register(platform, token)
  } catch (e) {
    const code = errName(e)
    d.log(`push: register failed (${code})`)
    if (code === 'unavailable') return 'unavailable'
    if (code === 'offline' || code === 'timeout') return 'offline'
    return 'failed'
  }
  await d.keys.saveReg({ fp, at: d.now() })
  return 'registered'
}
```

`apps/app/src/backend/types.ts`:
- `import type` 行追加 `PushPlatformT`(从 `@wechat-cc/protocol`)。
- `BackendCode` 改成 `'stale' | 'busy' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unavailable' | 'unknown'`。
- `Backend` 接口在 `unpair()` 之前加:

```ts
  /** 登记本机的 APNs / FCM token(POST /m/api/push/register)。daemon 没接推送(还没上 v2 中继)⇒ BackendError('unavailable')。 */
  registerPush(platform: PushPlatformT, token: string): Promise<void>
  /** 让电脑发一条测试通知(POST /m/api/push/test);code 是中继 / APNs / FCM 的结果码。 */
  testPush(): Promise<{ ok: boolean; code: string }>
```

`apps/app/src/net/errors.ts` 的 `mapPhoneError` 里,`if (err === 'matter_not_found') return 'not_found'` 之前加:

```ts
  if (err === 'push_not_wired') return 'unavailable'
```

`apps/app/src/backend/live.ts` 在 `async unpair()` 之前加:

```ts
    async registerPush(platform, token) {
      await call('POST /m/api/push/register', '/m/api/push/register', { body: { platform, token } })
    },
    async testPush() {
      return (await call<{ result: { ok: boolean; code: string } }>('POST /m/api/push/test', '/m/api/push/test', { body: {} })).result
    },
```

`apps/app/src/backend/demo.ts`:
- `const get = …` 里的 `new BackendError('unknown')` 改成 `new BackendError('not_found')`(与真后端 `matter_not_found` ⇒ `not_found` 对齐)。先 `grep -n "'unknown'" apps/app/src/backend/demo.test.ts`:若有用例断言「找不到 ⇒ unknown」,把期望改成 `not_found`。
- 在 `async unpair() {},` 之前加:

```ts
    async registerPush() {},
    async testPush() { return { ok: false, code: 'demo' } },
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd apps/app && bun run test && bun run typecheck; echo app=$?; cd ../..
bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts src/daemon/phone-app-push-e2e.test.ts; echo root=$?
```
Expected: `app=0`、`root=0`(推送 e2e 此时是一条 todo)。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/push apps/app/src/backend apps/app/src/net/errors.ts apps/app/src/net/errors.test.ts src/daemon/phone-app-push-e2e.test.ts src/daemon/phone-app-live-e2e.test.ts
git commit -m "app 推送:推送密钥记录、登记流程(syncPush)、Backend.registerPush / testPush;push_not_wired ⇒ unavailable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: app 纯逻辑 —— 点通知的目标、路由决定、前台横幅内容

**Files:**
- Create: `apps/app/src/push/target.ts`、`apps/app/src/push/route.ts`、`apps/app/src/push/banner.ts`
- Test: `apps/app/src/push/target.test.ts`、`apps/app/src/push/route.test.ts`、`apps/app/src/push/banner.test.ts`
- Modify: `src/daemon/phone-app-push-e2e.test.ts`(把 todo 换成完整用例)

**Interfaces:**
- Consumes:`PushKind`、`PushPlaintext`、`openPush`、`SealedPush`、`PushPlaintextT`(协议包);`BackendError`;`t`、`Lang`(i18n)。
- Produces:
  - `target.ts`:`type PushTarget = { kind: PushKindT; taskId?: string; requestId?: string }`;`cleanTarget(raw: unknown): PushTarget | null`;`targetFromParams(p: Record<string, string | string[] | undefined>): PushTarget | null`;`targetFromPlaintext(p: PushPlaintextT): PushTarget | null`;`targetFromNotification(n: unknown, fallback?: { key: Uint8Array; now: number }): PushTarget | null`
  - `route.ts`:`type PushRoute = { kind: 'home' } | { kind: 'gone' } | { kind: 'approval'; id: string; request?: string } | { kind: 'matter'; id: string }`;`resolvePushRoute(t: PushTarget | null, fetchDetail: (id: string) => Promise<unknown>, timeoutMs?: number): Promise<PushRoute>`;`hrefFor(r: PushRoute): string`;`pushOpenHref(t: PushTarget): string`
  - `banner.ts`:`RELAY_PLACEHOLDER_BODY = 'CC 有新动态'`;`type Banner = { title: string; body: string; target: PushTarget | null }`;`bannerFrom(n: unknown, lang: Lang, fallback?: { key: Uint8Array; now: number }): Banner`
  - 通知里的路由信息约定:iOS 扩展写 `userInfo.tendhearth = { kind, taskId?, requestId? }`(Task 7);expo-notifications 可能把它放在 `request.content.data` 或 `request.trigger.payload` —— 两处都找。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/push/target.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { derivePushKey, sealPush } from '@wechat-cc/protocol'
import { cleanTarget, targetFromParams, targetFromNotification, targetFromPlaintext } from './target'

const T = { kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' } as const

describe('cleanTarget —— 深链参数谁都能伪造,形状不对的一律丢', () => {
  it('合法的原样保留', () => { expect(cleanTarget(T)).toEqual(T) })
  it('未知 kind / 不是对象 ⇒ null', () => {
    expect(cleanTarget({ ...T, kind: 'approval_needed' })).toBeNull()
    expect(cleanTarget(null)).toBeNull()
    expect(cleanTarget('permission')).toBeNull()
  })
  it('taskId 不是 8 位小写 hex ⇒ 丢掉 taskId(之后回此刻);requestId 不合形状 ⇒ 丢掉 requestId', () => {
    expect(cleanTarget({ ...T, taskId: '../../x' })).toEqual({ kind: 'permission', requestId: 'perm-1' })
    expect(cleanTarget({ ...T, taskId: 'AB12CD34' })).toEqual({ kind: 'permission', requestId: 'perm-1' })
    expect(cleanTarget({ ...T, requestId: 'x'.repeat(129) })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
    expect(cleanTarget({ ...T, requestId: 'a/b' })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
    expect(cleanTarget({ ...T, requestId: 7 })).toEqual({ kind: 'permission', taskId: 'ab12cd34' })
  })
})

describe('targetFromParams(安卓深链 / 中转页参数)', () => {
  it('取数组的第一个;缺 kind ⇒ null', () => {
    expect(targetFromParams({ kind: ['permission', 'x'], taskId: 'ab12cd34', requestId: 'perm-1' })).toEqual(T)
    expect(targetFromParams({ taskId: 'ab12cd34' })).toBeNull()
  })
})

describe('targetFromNotification(iOS:expo-notifications 的通知对象)', () => {
  const n = (where: 'data' | 'payload', extra: Record<string, unknown>) => ({
    date: 1_700_000_000_000,
    request: { identifier: 'x', content: { title: 'Needs your approval', body: 'b', data: where === 'data' ? extra : {} }, trigger: { type: 'push', payload: where === 'payload' ? extra : {} } },
  })
  it('扩展写的 tendhearth 路由:content.data 或 trigger.payload 里都认', () => {
    expect(targetFromNotification(n('data', { tendhearth: T }))).toEqual(T)
    expect(targetFromNotification(n('payload', { tendhearth: T }))).toEqual(T)
  })
  it('扩展没解开(只有 wcc 密文)⇒ 有兜底密钥就在 app 里解;时间用通知送达时刻;wcc 是字符串也认', () => {
    const key = derivePushKey('d' + '0f'.repeat(24))
    const now = 1_700_000_000_000
    const sealed = sealPush(key, { ts: now - 1000, kind: 'question', title: 't', body: 'b', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key, now })).toEqual({ kind: 'question', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('data', { wcc: JSON.stringify(sealed) }), { key, now })).toEqual({ kind: 'question', taskId: 'ab12cd34', requestId: 'q-1' })
    expect(targetFromNotification(n('payload', { wcc: sealed }))).toBeNull()                                   // 没密钥
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key: derivePushKey('other'), now })).toBeNull() // 错钥
    expect(targetFromNotification(n('payload', { wcc: sealed }), { key, now: now + 2 * 3_600_000 })).toBeNull()  // 过期
  })
  it('什么都没有 / 不是对象 ⇒ null', () => {
    expect(targetFromNotification(n('data', {}))).toBeNull()
    expect(targetFromNotification(undefined)).toBeNull()
  })
  it('targetFromPlaintext:只取 kind / taskId / requestId', () => {
    expect(targetFromPlaintext({ ts: 1, kind: 'task_done', title: 't', body: 'b', taskId: 'ab12cd34' })).toEqual({ kind: 'task_done', taskId: 'ab12cd34' })
  })
})
```

`apps/app/src/push/route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { resolvePushRoute, hrefFor, pushOpenHref } from './route'
import { targetFromParams } from './target'

const ok = vi.fn(async () => ({}))

describe('resolvePushRoute —— 旧通知先定位事项、拉最新详情再展示(spec §3)', () => {
  it('批准 / 问题 ⇒ 批准页并钉住那条请求;没有 requestId ⇒ 批准页自己出选择列表', async () => {
    expect(await resolvePushRoute({ kind: 'permission', taskId: 'ab12cd34', requestId: 'perm-1' }, ok)).toEqual({ kind: 'approval', id: 'ab12cd34', request: 'perm-1' })
    expect(await resolvePushRoute({ kind: 'question', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'approval', id: 'ab12cd34' })
    expect(ok).toHaveBeenCalledWith('ab12cd34')
  })
  it('完成 / 失败 ⇒ 进展页', async () => {
    expect(await resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'matter', id: 'ab12cd34' })
    expect(await resolvePushRoute({ kind: 'task_failed', taskId: 'ab12cd34' }, ok)).toEqual({ kind: 'matter', id: 'ab12cd34' })
  })
  it('事情在电脑上已经不在(not_found)⇒ gone', async () => {
    expect(await resolvePushRoute({ kind: 'permission', taskId: 'ab12cd34', requestId: 'p' }, async () => { throw new BackendError('not_found') })).toEqual({ kind: 'gone' })
  })
  it('离线 / 超时 / 拉详情一直不回 ⇒ 照样进目标页(那页显示离线提示与上次同步的内容)', async () => {
    expect(await resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, async () => { throw new BackendError('offline') })).toEqual({ kind: 'matter', id: 'ab12cd34' })
    vi.useFakeTimers()
    const p = resolvePushRoute({ kind: 'task_done', taskId: 'ab12cd34' }, () => new Promise(() => {}), 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ kind: 'matter', id: 'ab12cd34' })
    vi.useRealTimers()
  })
  it('没目标 / 没 taskId(测试通知、解不开的占位)⇒ 回此刻,不发请求', async () => {
    const f = vi.fn(async () => ({}))
    expect(await resolvePushRoute(null, f)).toEqual({ kind: 'home' })
    expect(await resolvePushRoute({ kind: 'test' }, f)).toEqual({ kind: 'home' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('href', () => {
  it('hrefFor', () => {
    expect(hrefFor({ kind: 'approval', id: 'ab12cd34', request: 'perm 1' })).toBe('/approval/ab12cd34?request=perm%201')
    expect(hrefFor({ kind: 'approval', id: 'ab12cd34' })).toBe('/approval/ab12cd34')
    expect(hrefFor({ kind: 'matter', id: 'ab12cd34' })).toBe('/matter/ab12cd34')
    expect(hrefFor({ kind: 'home' })).toBe('/')
    expect(hrefFor({ kind: 'gone' })).toBe('/')
  })
  it('pushOpenHref ↔ targetFromParams 往返', () => {
    const t = { kind: 'permission', taskId: 'ab12cd34', requestId: 'r:1.x' } as const
    const href = pushOpenHref(t)
    expect(href.startsWith('/push-open?')).toBe(true)
    expect(targetFromParams(Object.fromEntries(new URLSearchParams(href.split('?')[1])))).toEqual(t)
  })
})
```

`apps/app/src/push/banner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bannerFrom, RELAY_PLACEHOLDER_BODY } from './banner'

const n = (title: string, body: string, data: Record<string, unknown> = {}) => ({ date: 1, request: { identifier: 'i', content: { title, body, data }, trigger: { type: 'push', payload: {} } } })

describe('bannerFrom —— app 在前台时自己的横幅(spec §7「正在用 app 时」)', () => {
  it('扩展解开了:用它换好的标题与正文,带上路由', () => {
    expect(bannerFrom(n('Needs your approval', '整理作品集:npm i', { tendhearth: { kind: 'permission', taskId: 'ab12cd34', requestId: 'p' } }), 'en'))
      .toEqual({ title: 'Needs your approval', body: '整理作品集:npm i', target: { kind: 'permission', taskId: 'ab12cd34', requestId: 'p' } })
  })
  it('还是中继的中文占位 / 空正文 ⇒ 按 app 语言显示中性占位,点开回此刻', () => {
    expect(bannerFrom(n('CC', RELAY_PLACEHOLDER_BODY), 'en')).toEqual({ title: 'CC', body: 'CC has news', target: null })
    expect(bannerFrom(n('', ''), 'zh-Hans')).toEqual({ title: 'CC', body: 'CC 有新动态', target: null })
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -8; cd ../..`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`apps/app/src/push/target.ts`:

```ts
import { openPush, PushKind, PushPlaintext, type PushKindT, type PushPlaintextT, type SealedPush } from '@wechat-cc/protocol'

// 点通知的目标(spec §7「点通知」)。来源不可信:安卓深链谁都能发,iOS 的 userInfo 来自扩展或(没解开时)中继转来的密文。
// 形状不对的字段一律丢:taskId 丢了就回此刻,requestId 丢了批准页自己出选择列表。

export type PushTarget = { kind: PushKindT; taskId?: string; requestId?: string }

const TASK = /^[a-f0-9]{8}$/
const REQ = /^[A-Za-z0-9_.:-]{1,128}$/
const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function cleanTarget(raw: unknown): PushTarget | null {
  const o = obj(raw)
  if (!o) return null
  const kind = PushKind.safeParse(o.kind)
  if (!kind.success) return null
  const out: PushTarget = { kind: kind.data }
  if (typeof o.taskId === 'string' && TASK.test(o.taskId)) out.taskId = o.taskId
  if (typeof o.requestId === 'string' && REQ.test(o.requestId)) out.requestId = o.requestId
  return out
}

export function targetFromParams(p: Record<string, string | string[] | undefined>): PushTarget | null {
  return cleanTarget({ kind: one(p.kind), taskId: one(p.taskId), requestId: one(p.requestId) })
}

export function targetFromPlaintext(p: PushPlaintextT): PushTarget | null {
  return cleanTarget({ kind: p.kind, taskId: p.taskId, requestId: p.requestId })
}

/**
 * expo-notifications 的通知对象 → 目标。先找扩展写好的 `tendhearth` 路由(content.data 或 trigger.payload);
 * 扩展没解开(锁屏后首次解锁前、超时)⇒ 用兜底密钥在 app 里解 `wcc`,时间用通知送达时刻(点开时可能已过 1 小时)。
 */
export function targetFromNotification(n: unknown, fallback?: { key: Uint8Array; now: number }): PushTarget | null {
  const req = obj(obj(n)?.request)
  const sources = [obj(obj(req?.content)?.data), obj(obj(req?.trigger)?.payload)]
  for (const s of sources) {
    if (s?.tendhearth !== undefined) return cleanTarget(s.tendhearth)
  }
  if (!fallback) return null
  for (const s of sources) {
    let w = s?.wcc
    if (w === undefined) continue
    if (typeof w === 'string') { try { w = JSON.parse(w) } catch { continue } }
    try {
      const p = PushPlaintext.safeParse(openPush(fallback.key, w as SealedPush, fallback.now))
      if (p.success) return targetFromPlaintext(p.data)
    } catch { /* 错钥 / 篡改 / 过期:当没目标 */ }
  }
  return null
}
```

`apps/app/src/push/route.ts`:

```ts
import { BackendError } from '../backend/types'
import type { PushTarget } from './target'

export type PushRoute =
  | { kind: 'home' }
  | { kind: 'gone' }
  | { kind: 'approval'; id: string; request?: string }
  | { kind: 'matter'; id: string }

/**
 * 旧通知(spec §3):先按 taskId 拉一次最新详情。事情不在 ⇒ gone;拉不到(离线 / 超时)⇒ 照样去目标页,
 * 那页自己显示离线提示。批准页与进展页打开时还会再拉新(refreshOnMount),请求已处理 ⇒ 批准页显示「已处理」。
 */
export async function resolvePushRoute(t: PushTarget | null, fetchDetail: (id: string) => Promise<unknown>, timeoutMs = 5000): Promise<PushRoute> {
  if (!t || !t.taskId) return { kind: 'home' }
  const id = t.taskId
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fetchDetail(id),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new BackendError('timeout')), timeoutMs) }),
    ])
  } catch (e) {
    if (e instanceof BackendError && e.code === 'not_found') return { kind: 'gone' }
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (t.kind === 'permission' || t.kind === 'question') return { kind: 'approval', id, ...(t.requestId ? { request: t.requestId } : {}) }
  return { kind: 'matter', id }
}

export function hrefFor(r: PushRoute): string {
  if (r.kind === 'approval') return `/approval/${encodeURIComponent(r.id)}${r.request ? `?request=${encodeURIComponent(r.request)}` : ''}`
  if (r.kind === 'matter') return `/matter/${encodeURIComponent(r.id)}`
  return '/'
}

export function pushOpenHref(t: PushTarget): string {
  const q = new URLSearchParams({ kind: t.kind })
  if (t.taskId) q.set('taskId', t.taskId)
  if (t.requestId) q.set('requestId', t.requestId)
  return `/push-open?${q.toString()}`
}
```

`apps/app/src/push/banner.ts`:

```ts
import { t, type Lang } from '../i18n'
import { targetFromNotification, type PushTarget } from './target'

/** apps/relay/src/push-apns.ts 发给 APNs 的占位正文(plugins/native-guards.test.ts 钉住两边一致)。 */
export const RELAY_PLACEHOLDER_BODY = 'CC 有新动态'

export type Banner = { title: string; body: string; target: PushTarget | null }

const str = (x: unknown) => (typeof x === 'string' ? x : '')

export function bannerFrom(n: unknown, lang: Lang, fallback?: { key: Uint8Array; now: number }): Banner {
  const content = (n as { request?: { content?: { title?: unknown; body?: unknown } } } | null)?.request?.content
  const title = str(content?.title)
  const body = str(content?.body)
  const target = targetFromNotification(n, fallback)
  const neutral = body === '' || body === RELAY_PLACEHOLDER_BODY
  return {
    title: neutral ? t(lang, 'push.placeholderTitle') : title || t(lang, 'push.placeholderTitle'),
    body: neutral ? t(lang, 'push.placeholder') : body,
    target,
  }
}
```

`apps/app/src/i18n/en.ts` 加:`'push.placeholderTitle': 'CC',`、`'push.placeholder': 'CC has news',`;`zh-Hans.ts` 加:`'push.placeholderTitle': 'CC',`、`'push.placeholder': 'CC 有新动态',`(放在文件末尾附近,两份位置对齐)。

`src/daemon/phone-app-push-e2e.test.ts`:把 Task 5 的占位版本整个换成 Task 5 Step 1 里写出的完整文件(带 `makePhonePush`、`pushKeyRecord`、`targetFromParams` / `targetFromPlaintext`、`pushOpenHref` 的那一版)。

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd apps/app && bun run test && bun run typecheck; echo app=$?; cd ../..
bun --bun vitest run src/daemon/phone-app-push-e2e.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/phone-app-push-e2e.test.ts; echo root=$?
bun run typecheck; echo tc=$?
```
Expected: 全部 `0`(根 typecheck 证明被根测试 import 的 `src/push/{key-store,target,route}.ts` 过根 tsconfig)。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/push apps/app/src/i18n src/daemon/phone-app-push-e2e.test.ts
git commit -m "app 推送:点通知的目标解析(不可信输入)、路由决定(先拉详情)、前台横幅;daemon 封的推送 app 能解开能路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: iOS —— 通知服务扩展、config plugin、app.config.js、双语 locale

**Files:**
- Create: `apps/app/native/ios-notify/Extension/NotificationService.swift`、`apps/app/native/ios-notify/Extension/ExtensionStores.swift`
- Create: `apps/app/plugins/push-strings.js`、`apps/app/plugins/with-ios-notify.js`、`apps/app/app.config.js`
- Create: `apps/app/locales/en.json`、`apps/app/locales/zh-Hans.json`
- Modify: `apps/app/app.json`、`apps/app/package.json`(expo-notifications)、`apps/app/vitest.config.ts`、`apps/app/.gitignore`
- Test: `apps/app/plugins/push-strings.test.ts`、`apps/app/plugins/app-config.test.ts`、`apps/app/plugins/native-guards.test.ts`

**Interfaces:**
- Consumes:PushCore(Task 3)、`push-strings.json`、`PUSH_KEY_ITEM` / `PUSH_KEY_SERVICE`(Task 5,Swift 里写成同样的字面量,守卫测试核对)。
- Produces:
  - `plugins/push-strings.js`:`swiftSource(table): string`、`kotlinSource(table): string`、`loadStrings(): table`
  - `plugins/with-ios-notify.js`:默认导出 config plugin `(config, { teamId }) => config`;导出 `TARGET = 'TendhearthNotify'`、`SHARED_GROUP = 'com.tendhearth.app.shared'`、`infoPlist({ version, build }): string`、`entitlementsPlist(): string`、`mainKeychainGroups(bundleId): string[]`
  - `app.config.js`:`extra.apnsEnv`('development' | 'production',来自 `TENDHEARTH_APNS_ENV`)、`extra.keychainGroup`(`<TEAM>.com.tendhearth.app.shared`)、`extra.eas.build.experimental.ios.appExtensions`
  - 扩展写进通知的 `userInfo["tendhearth"] = { kind, taskId?, requestId? }`

- [ ] **Step 1: 装 expo-notifications 并核对假设**

```bash
cd apps/app && bunx expo install expo-notifications; cd ../..
N=$(cd apps/app && node -p "require('path').dirname(require.resolve('expo-notifications/package.json'))")
grep -n "aps-environment\|mode" "$N"/plugin/build/*.js | head
grep -n "useLastNotificationResponse\|DEFAULT_ACTION_IDENTIFIER\|getDevicePushTokenAsync\|addPushTokenListener\|setNotificationCategoryAsync\|shouldShowBanner" "$N"/build/index.d.ts "$N"/build/*.d.ts | head -20
grep -rn "firebase-messaging" "$N"/android/build.gradle
grep -n "FirebaseMessagingService\|MESSAGING_EVENT" "$N"/android/src/main/AndroidManifest.xml
grep -n "date" "$N"/build/Notifications.types.d.ts | head -5
```
Expected 并记下:
- 插件 `mode` 选项设置 `aps-environment`(若选项名不同,在 `app.config.js` 用实际名字);
- 上面列的 API 都存在(若 `useLastNotificationResponse` 已改名,在 Task 10 用实际名字);
- `firebase-messaging:<版本>` 那一行(Task 8 的插件在 prebuild 时读它);
- manifest 里 expo 自己的消息服务类名(预期 `expo.modules.notifications.service.ExpoFirebaseMessagingService`,Task 8 用);
- `Notification.date` 的单位(预期毫秒;若是秒,Task 10 乘 1000)。

- [ ] **Step 2: 写失败的测试**

`apps/app/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts', 'plugins/**/*.test.ts', 'scripts/**/*.test.ts'], environment: 'node' } })
```

`apps/app/plugins/push-strings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { swiftSource, kotlinSource, loadStrings } from './push-strings'
import en from '../src/i18n/en'
import zh from '../src/i18n/zh-Hans'

describe('原生通知文案生成器', () => {
  it('两种语言键一致', () => {
    const s = loadStrings()
    expect(Object.keys(s['zh-Hans']).sort()).toEqual(Object.keys(s.en).sort())
  })
  it('Swift:enum PushStrings 的字典字面量;引号、反斜杠、换行转义', () => {
    const src = swiftSource({ en: { a: 'say "hi"\\\n' }, 'zh-Hans': { a: '中' } })
    expect(src).toContain('enum PushStrings')
    expect(src).toContain('"a": "say \\"hi\\"\\\\\\n"')
    expect(src).toContain('"zh-Hans": [')
  })
  it('Kotlin:object PushStrings 的 mapOf;$ 也转义', () => {
    const src = kotlinSource({ en: { a: 'cost $5 "x"' }, 'zh-Hans': { a: '中' } })
    expect(src).toContain('package com.tendhearth.app.push')
    expect(src).toContain('"a" to "cost \\$5 \\"x\\""')
  })
  it('安卓渠道名与 app 里建渠道用的 JS 文案一致(同一个渠道只能有一个名字)', () => {
    const s = loadStrings()
    expect(s.en['channel.decide']).toBe(en['push.channelDecide'])
    expect(s.en['channel.updates']).toBe(en['push.channelUpdates'])
    expect(s['zh-Hans']['channel.decide']).toBe(zh['push.channelDecide'])
    expect(s['zh-Hans']['channel.updates']).toBe(zh['push.channelUpdates'])
  })
})
```

(`src/i18n/en.ts` / `zh-Hans.ts` 若不是 `export default`,改成与 `i18n.test.ts` 相同的 import 方式;`push.channelDecide` / `push.channelUpdates` 在本任务 Step 4 加进文案表。)

`apps/app/plugins/app-config.test.ts`:

```ts
import { createRequire } from 'node:module'
import { afterEach, describe, it, expect } from 'vitest'
import base from '../app.json'

const require = createRequire(import.meta.url)
const load = () => { delete require.cache[require.resolve('../app.config.js')]; return require('../app.config.js') as (a: { config: typeof base.expo }) => any }
const envKeys = ['TENDHEARTH_APNS_ENV', 'APPLE_TEAM_ID', 'GOOGLE_SERVICES_JSON'] as const
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
afterEach(() => { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('app.config.js', () => {
  it('默认:开发 APNs、团队 9Y6JAPDP7A 的共享钥匙串组、主 app 自己的组排第一', () => {
    for (const k of envKeys) delete process.env[k]
    const c = load()({ config: base.expo })
    expect(c.extra.apnsEnv).toBe('development')
    expect(c.extra.keychainGroup).toBe('9Y6JAPDP7A.com.tendhearth.app.shared')
    expect(c.ios.appleTeamId).toBe('9Y6JAPDP7A')
    expect(c.ios.entitlements['keychain-access-groups']).toEqual(['$(AppIdentifierPrefix)com.tendhearth.app', '$(AppIdentifierPrefix)com.tendhearth.app.shared'])
    expect(c.plugins).toContainEqual(['expo-notifications', expect.objectContaining({ mode: 'development' })])
    expect(c.plugins).toContainEqual(['./plugins/with-ios-notify', { teamId: '9Y6JAPDP7A' }])
    expect(c.plugins).toContain('./plugins/with-android-push')
    expect(c.android.googleServicesFile).toBeUndefined()
    expect(c.extra.eas.build.experimental.ios.appExtensions).toEqual([{
      targetName: 'TendhearthNotify', bundleIdentifier: 'com.tendhearth.app.notify',
      entitlements: { 'keychain-access-groups': ['$(AppIdentifierPrefix)com.tendhearth.app.shared'] },
    }])
  })
  it('TENDHEARTH_APNS_ENV=production(TestFlight / 商店);GOOGLE_SERVICES_JSON 指到文件', () => {
    process.env.TENDHEARTH_APNS_ENV = 'production'
    process.env.GOOGLE_SERVICES_JSON = '/tmp/gs.json'
    const c = load()({ config: base.expo })
    expect(c.extra.apnsEnv).toBe('production')
    expect(c.plugins).toContainEqual(['expo-notifications', expect.objectContaining({ mode: 'production' })])
    expect(c.android.googleServicesFile).toBe('/tmp/gs.json')
  })
  it('app.json 里原有的插件都还在', () => {
    const c = load()({ config: base.expo })
    for (const p of base.expo.plugins) expect(c.plugins).toContainEqual(p)
  })
})
```

`apps/app/plugins/native-guards.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { PUSH_KEY_ITEM, PUSH_KEY_SERVICE } from '../src/push/key-store'
import { RELAY_PLACEHOLDER_BODY } from '../src/push/banner'

// 原生端直接读 expo-secure-store 的存储、按中继的占位文字判断:这些是别人的实现细节,升级依赖时这里先红。
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')
const here = dirname(fileURLToPath(import.meta.url))

describe('expo-secure-store 的 iOS 钥匙串属性(扩展按它查推送密钥)', () => {
  const swift = read(pkgDir('expo-secure-store'), 'ios', 'SecureStoreModule.swift')
  it('service = keychainService + ":no-auth";account = 键名的 UTF-8', () => {
    expect(swift).toContain('var service = options.keychainService ?? "app"')
    expect(swift).toContain('service.append(":\\(requireAuthentication ? "auth" : "no-auth")")')
    expect(swift).toContain('let encodedKey = Data(key.utf8)')
    expect(swift).toContain('kSecAttrAccount as String: encodedKey')
  })
  it('扩展源码里的 service / account 与 key-store.ts 一致', () => {
    const ext = read(here, '..', 'native', 'ios-notify', 'Extension', 'ExtensionStores.swift')
    expect(ext).toContain(`"${PUSH_KEY_SERVICE}:no-auth"`)
    expect(ext).toContain(`"${PUSH_KEY_ITEM}"`)
  })
})

describe('中继的 APNs 占位', () => {
  it('apps/relay/src/push-apns.ts 的占位正文就是 RELAY_PLACEHOLDER_BODY', () => {
    expect(read(here, '..', '..', 'relay', 'src', 'push-apns.ts')).toContain(`body: '${RELAY_PLACEHOLDER_BODY}'`)
  })
})
```

(安卓那一半的守卫在 Task 8 追加到同一文件。)

- [ ] **Step 3: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -8; cd ../..`
Expected: FAIL(`./push-strings`、`../app.config.js`、`ExtensionStores.swift` 不存在)。

- [ ] **Step 4: 实现 —— 生成器、扩展源码、插件、配置、locale**

`apps/app/plugins/push-strings.js`:

```js
// 由 native/push-strings.json 生成原生文案常量(prebuild 时写进 ios/ 与 android/,不进 git)。
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'native', 'push-strings.json')
const loadStrings = () => JSON.parse(fs.readFileSync(FILE, 'utf8'))
const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

function swiftSource(table) {
  const langs = Object.entries(table).map(([lang, t]) =>
    `    "${esc(lang)}": [\n${Object.entries(t).map(([k, v]) => `      "${esc(k)}": "${esc(v)}",`).join('\n')}\n    ],`)
  return `// 生成自 apps/app/native/push-strings.json(plugins/push-strings.js),别手改。\nenum PushStrings {\n  static let table: [String: [String: String]] = [\n${langs.join('\n')}\n  ]\n}\n`
}

function kotlinSource(table) {
  const k = s => esc(s).replace(/\$/g, '\\$')
  const langs = Object.entries(table).map(([lang, t]) =>
    `    "${k(lang)}" to mapOf(\n${Object.entries(t).map(([a, b]) => `      "${k(a)}" to "${k(b)}",`).join('\n')}\n    ),`)
  return `// 生成自 apps/app/native/push-strings.json(plugins/push-strings.js),别手改。\npackage com.tendhearth.app.push\n\nobject PushStrings {\n  val table: Map<String, Map<String, String>> = mapOf(\n${langs.join('\n')}\n  )\n}\n`
}

module.exports = { loadStrings, swiftSource, kotlinSource }
```

`apps/app/native/ios-notify/Extension/ExtensionStores.swift`:

```swift
import Foundation
import Security

/// 读 app 经 expo-secure-store 写进共享钥匙串的推送密钥记录(src/push/key-store.ts)。
/// expo-secure-store 的查询形状:service = "<keychainService>:no-auth",account = 键名的 UTF-8(plugins/native-guards.test.ts 钉住)。
/// 不指定 access group:扩展只有共享组这一个组,查询自然落在那里。
enum PushKeyStore {
  static func load() -> PushKeyRecord? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "tendhearth.push:no-auth",
      kSecAttrAccount as String: Data("tendhearth.pushkey.v1".utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
    return PushKeyRecord.parse(s)
  }
}

/// 去重记录放在扩展自己容器的 UserDefaults(不需要 App Group:只有扩展读写它)。
enum DedupeStore {
  static let key = "tendhearth.push.dedupe"
  static func seen(_ k: String, nowMs: Int64) -> Bool {
    let d = UserDefaults.standard
    let raw = d.dictionary(forKey: key) as? [String: NSNumber] ?? [:]
    var store = PushDedupe(entries: raw.mapValues { $0.int64Value })
    let dup = store.seen(k, nowMs: nowMs)
    d.set(store.entries.mapValues { NSNumber(value: $0) }, forKey: key)
    return dup
  }
}
```

`apps/app/native/ios-notify/Extension/NotificationService.swift`:

```swift
import Foundation
import UserNotifications

/// 通知服务扩展(spec §7):中继发来的是占位 alert + mutable-content + `wcc` 密文。这里先把内容换成本地化的中性占位,
/// 再用共享钥匙串里的推送密钥解密;解开且合形状 ⇒ 按 kind 换标题、正文、category、线程、路由。
/// 任何一步失败或系统催超时 ⇒ 交出中性占位。从不记录明文、密钥或密文。
final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var best: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { contentHandler(request.content); return }
    best = content
    let record = PushKeyStore.load()
    let lang = PushPresenter.lang(record: record?.lang, preferred: Locale.preferredLanguages)
    apply(PushPresenter.placeholder(lang: lang, strings: PushStrings.table), to: content)

    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    if let key = record?.key, case .success(let opened) = PushCrypto.open(key: key, sealed: request.content.userInfo["wcc"], nowMs: nowMs),
       let msg = PushMessage.parse(opened.payload) {
      apply(PushPresenter.display(msg, lang: lang, strings: PushStrings.table), to: content)
      // iOS 不能丢掉一条推送(除非有 Apple 特批的过滤权限):重复的那条改成不响不亮(计划裁决 3)。
      if DedupeStore.seen(PushDedupe.key(ts: msg.ts, ct: opened.ct), nowMs: nowMs), #available(iOS 15.0, *) {
        content.interruptionLevel = .passive
        content.sound = nil
      }
    }
    deliver()
  }

  override func serviceExtensionTimeWillExpire() { deliver() }

  private func apply(_ d: PushDisplay, to c: UNMutableNotificationContent) {
    c.title = d.title
    c.body = d.body
    c.categoryIdentifier = d.category ?? ""
    c.threadIdentifier = d.thread ?? ""
    var info = c.userInfo
    info["tendhearth"] = d.route
    c.userInfo = info
  }

  private func deliver() {
    guard let h = handler, let c = best else { return }
    handler = nil
    h(c)
  }
}
```

`apps/app/plugins/with-ios-notify.js`:

```js
// iOS 通知服务扩展(spec §7):prebuild 时建 TendhearthNotify target、拷源码、写 Info.plist 与 entitlements,
// 主 app 加 keychain-access-groups。源码只在 native/ios-notify/,ios/ 不进 git。重复 prebuild(不带 --clean)也幂等。
const fs = require('fs')
const path = require('path')
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')
const { loadStrings, swiftSource } = require('./push-strings')

const TARGET = 'TendhearthNotify'
const SHARED_GROUP = 'com.tendhearth.app.shared'
const NATIVE = path.join(__dirname, '..', 'native', 'ios-notify')
const SWIFT_FILES = [
  ...fs.readdirSync(path.join(NATIVE, 'Sources', 'PushCore')).filter(f => f.endsWith('.swift')).map(f => path.join(NATIVE, 'Sources', 'PushCore', f)),
  ...fs.readdirSync(path.join(NATIVE, 'Extension')).filter(f => f.endsWith('.swift')).map(f => path.join(NATIVE, 'Extension', f)),
]

const mainKeychainGroups = bundleId => [`$(AppIdentifierPrefix)${bundleId}`, `$(AppIdentifierPrefix)${SHARED_GROUP}`]

const infoPlist = ({ version, build }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>${TARGET}</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`

const entitlementsPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array><string>$(AppIdentifierPrefix)${SHARED_GROUP}</string></array>
</dict>
</plist>
`

function writeExtensionFiles(iosRoot, { version, build }) {
  const dir = path.join(iosRoot, TARGET)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of SWIFT_FILES) fs.copyFileSync(f, path.join(dir, path.basename(f)))
  fs.writeFileSync(path.join(dir, 'PushStrings.swift'), swiftSource(loadStrings()))
  fs.writeFileSync(path.join(dir, 'Info.plist'), infoPlist({ version, build }))
  fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), entitlementsPlist())
}

function addExtensionTarget(project, { bundleId, teamId }) {
  if (project.pbxTargetByName(TARGET)) return
  const objects = project.hash.project.objects
  objects.PBXTargetDependency = objects.PBXTargetDependency || {}
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {}

  // 主 target 的部署版本抄给扩展
  let deployment = '16.0'
  const configs = project.pbxXCBuildConfigurationSection()
  for (const k of Object.keys(configs)) {
    const s = configs[k] && configs[k].buildSettings
    if (s && s.IPHONEOS_DEPLOYMENT_TARGET && s.PRODUCT_BUNDLE_IDENTIFIER && String(s.PRODUCT_BUNDLE_IDENTIFIER).replace(/"/g, '') === bundleId) deployment = s.IPHONEOS_DEPLOYMENT_TARGET
  }

  const sources = [...SWIFT_FILES.map(f => path.basename(f)), 'PushStrings.swift']
  const target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.notify`)
  const group = project.addPbxGroup([...sources, 'Info.plist', `${TARGET}.entitlements`], TARGET, TARGET)
  const mainGroup = project.getFirstProject().firstProject.mainGroup
  project.addToPbxGroup(group.uuid, mainGroup)
  project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)

  for (const k of Object.keys(configs)) {
    const c = configs[k]
    if (!c || !c.buildSettings || c.buildSettings.PRODUCT_NAME !== `"${TARGET}"`) continue
    Object.assign(c.buildSettings, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: teamId,
      IPHONEOS_DEPLOYMENT_TARGET: deployment,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: '5.0',
      PRODUCT_BUNDLE_IDENTIFIER: `${bundleId}.notify`,
      GENERATE_INFOPLIST_FILE: 'NO',
      SKIP_INSTALL: 'YES',
    })
  }
}

function withIosNotify(config, { teamId }) {
  const bundleId = config.ios.bundleIdentifier
  config = withEntitlementsPlist(config, c => {
    c.modResults['keychain-access-groups'] = mainKeychainGroups(bundleId)
    return c
  })
  config = withDangerousMod(config, ['ios', c => {
    writeExtensionFiles(c.modRequest.platformProjectRoot, { version: c.version || '1.0.0', build: (c.ios && c.ios.buildNumber) || '1' })
    return c
  }])
  config = withXcodeProject(config, c => {
    addExtensionTarget(c.modResults, { bundleId, teamId })
    return c
  })
  return config
}

module.exports = withIosNotify
module.exports.TARGET = TARGET
module.exports.SHARED_GROUP = SHARED_GROUP
module.exports.infoPlist = infoPlist
module.exports.entitlementsPlist = entitlementsPlist
module.exports.mainKeychainGroups = mainKeychainGroups
```

`apps/app/app.config.js`:

```js
// app.json 是底;这里只加随构建环境变化的部分(spec §4、§7):
// - TENDHEARTH_APNS_ENV:development(开发构建,沙盒 APNs)/ production(TestFlight、商店、内部分发)——决定 aps-environment 与登记的平台
// - APPLE_TEAM_ID:默认 Nate Gu & Co LLC 的 9Y6JAPDP7A;共享钥匙串组 = <团队>.com.tendhearth.app.shared
// - GOOGLE_SERVICES_JSON:EAS 的文件型环境变量,或本地 apps/app/google-services.json(都不进 git);没有 ⇒ 安卓拿不到 FCM token(显示「不可用」)
const fs = require('fs')
const path = require('path')

module.exports = ({ config }) => {
  const team = process.env.APPLE_TEAM_ID || '9Y6JAPDP7A'
  const apnsEnv = process.env.TENDHEARTH_APNS_ENV === 'production' ? 'production' : 'development'
  const localGs = path.join(__dirname, 'google-services.json')
  const gs = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(localGs) ? './google-services.json' : undefined)
  const bundleId = config.ios.bundleIdentifier
  return {
    ...config,
    ios: {
      ...config.ios,
      appleTeamId: team,
      entitlements: { ...(config.ios.entitlements || {}), 'keychain-access-groups': [`$(AppIdentifierPrefix)${bundleId}`, '$(AppIdentifierPrefix)com.tendhearth.app.shared'] },
    },
    android: { ...config.android, ...(gs ? { googleServicesFile: gs } : {}) },
    plugins: [
      ...config.plugins,
      ['expo-notifications', { mode: apnsEnv, icon: './assets/images/notification-icon.png', color: '#58654c' }],
      ['./plugins/with-ios-notify', { teamId: team }],
      './plugins/with-android-push',
    ],
    extra: {
      ...(config.extra || {}),
      apnsEnv,
      keychainGroup: `${team}.com.tendhearth.app.shared`,
      eas: {
        ...((config.extra && config.extra.eas) || {}),
        build: { experimental: { ios: { appExtensions: [{
          targetName: 'TendhearthNotify',
          bundleIdentifier: `${bundleId}.notify`,
          entitlements: { 'keychain-access-groups': ['$(AppIdentifierPrefix)com.tendhearth.app.shared'] },
        }] } } },
      },
    },
  }
}
```

(Step 1 若发现 expo-notifications 的选项名不是 `mode`,两处一起改,并改 `app-config.test.ts`。`with-android-push` 在 Task 8 建;本任务先建一个只 `module.exports = config => config` 的占位文件,让 `export:check` 能加载配置。`notification-icon.png` 同样在 Task 8 生成;本任务先 `cp apps/app/assets/images/android-icon-monochrome.png apps/app/assets/images/notification-icon.png` 占位。)

`apps/app/locales/en.json`:

```json
{
  "CFBundleDisplayName": "Tendhearth",
  "NSCameraUsageDescription": "Tendhearth uses the camera only to scan the pairing code shown on your computer."
}
```

`apps/app/locales/zh-Hans.json`:

```json
{
  "CFBundleDisplayName": "Tendhearth",
  "NSCameraUsageDescription": "Tendhearth 只用相机扫描电脑上显示的配对码。"
}
```

(iOS 的通知权限没有用途说明字符串 —— 系统框的文字由系统给,见计划裁决 7。)

`apps/app/app.json` 的 `expo` 下加 `"locales": { "en": "./locales/en.json", "zh-Hans": "./locales/zh-Hans.json" }`;`plugins` 保持原样(新插件都在 `app.config.js` 里追加)。

`apps/app/.gitignore` 的「Native secrets」段加:

```
google-services.json
GoogleService-Info.plist
```

文案(本任务用到的渠道名,Task 9 还会再加别的):`en.ts` 加 `'push.channelDecide': 'Needs your decision',`、`'push.channelUpdates': 'Done and didn’t finish',`;`zh-Hans.ts` 加 `'push.channelDecide': '需要你决定',`、`'push.channelUpdates': '完成与失败',`。

`plugins/app-config.test.ts` 里再加一条 locale 双语核对:

```ts
  it('iOS 权限说明 en 与 zh-Hans 同时存在、键一致(计划 3 裁决:只有 zh 会把 en-GB 用户翻成中文)', () => {
    const c = load()({ config: base.expo })
    expect(Object.keys(c.locales).sort()).toEqual(['en', 'zh-Hans'])
    const en = require('../locales/en.json'), zh = require('../locales/zh-Hans.json')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const cam = base.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-camera') as [string, { cameraPermission: string }]
    expect(en.NSCameraUsageDescription).toBe(cam[1].cameraPermission)
  })
```

- [ ] **Step 5: 跑单测**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..`
Expected: `app=0`。

- [ ] **Step 6: prebuild + 模拟器构建(本机验证,CI 不跑)**

```bash
cd apps/app
bunx expo prebuild --platform ios --clean --no-install && (cd ios && pod install) ; echo prebuild=$?
bunx expo prebuild --platform ios --no-install ; echo again=$?          # 幂等:第二次不重复加 target
grep -c 'TendhearthNotify.appex' ios/Tendhearth.xcodeproj/project.pbxproj
UDID=$(cat /tmp/th-push-udid)
xcodebuild -workspace ios/Tendhearth.xcworkspace -scheme Tendhearth -configuration Debug -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath /tmp/th-build build <Task 1 README 里记下的签名参数> 2>&1 | tail -3; echo build=${pipestatus[1]}
APP=/tmp/th-build/Build/Products/Debug-iphonesimulator/Tendhearth.app
ls "$APP/PlugIns/TendhearthNotify.appex"
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -A3 keychain-access-groups
codesign -d --entitlements :- "$APP/PlugIns/TendhearthNotify.appex" 2>/dev/null | grep -A2 keychain-access-groups
cd ../..
```
Expected:`prebuild=0`、`again=0`;`grep -c` 输出与第一次相同(不翻倍);`build=0`;`.appex` 存在;主 app 两个组(自己的在前)、扩展一个共享组。
若 `xcodebuild` 因扩展报错:按报错修 `with-ios-notify.js`(常见:缺 `PBXTargetDependency` 段、`Embed App Extensions` 的 dstSubfolderSpec、SWIFT_VERSION),重跑本步。

- [ ] **Step 7: Commit**

```bash
git add apps/app/native/ios-notify/Extension apps/app/plugins apps/app/app.config.js apps/app/app.json apps/app/locales apps/app/package.json bun.lock apps/app/vitest.config.ts apps/app/.gitignore apps/app/src/i18n apps/app/assets/images/notification-icon.png
git status --short   # 确认没有 ios/、android/、.superpowers/
git commit -m "app 推送:iOS 通知服务扩展(Swift,共享钥匙串读推送密钥)+ config plugin + app.config.js + 双语 locale

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(以上路径都相对仓库根;`bun.lock` 在仓库根。)

---

### Task 8: 安卓 —— 消息服务、config plugin、google-services、通知图标与单色图

**Files:**
- Create: `apps/app/native/android-push/android/TendhearthMessagingService.kt`、`apps/app/native/android-push/android/SecureStoreReader.kt`
- Modify: `apps/app/plugins/with-android-push.js`(替换 Task 7 的占位)
- Modify: `apps/app/assets/images/android-icon-monochrome.png`、`apps/app/assets/images/notification-icon.png`
- Test: `apps/app/plugins/android-push.test.ts`、`apps/app/plugins/native-guards.test.ts`(追加)

**Interfaces:**
- Consumes:Kotlin 核心(Task 4)、`push-strings.js`(Task 7)、expo-notifications 的 firebase-messaging 版本与服务类名(Task 7 Step 1)。
- Produces:
  - `with-android-push.js`:默认导出 config plugin;导出 `firebaseMessagingVersion(gradleText: string): string`、`patchManifest(manifest): manifest`、`patchAppGradle(text, version): string`、`SERVICE = '.push.TendhearthMessagingService'`、`EXPO_SERVICE`
  - 安卓点通知 ⇒ `Intent.ACTION_VIEW` 打开 `tendhearth://push-open?kind=…&taskId=…&requestId=…`(Task 10 的中转页接)

- [ ] **Step 1: 写失败的测试**

`apps/app/plugins/android-push.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const p = require('./with-android-push.js') as {
  firebaseMessagingVersion(t: string): string
  patchManifest(m: any): any
  patchAppGradle(t: string, v: string): string
  SERVICE: string
  EXPO_SERVICE: string
}
const manifest = () => ({ manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ $: { 'android:name': '.MainApplication' }, activity: [] }] } })

describe('with-android-push', () => {
  it('从 expo-notifications 的 build.gradle 读出 firebase-messaging 版本(与它用同一个)', () => {
    const gradle = readFileSync(join(dirname(require.resolve('expo-notifications/package.json')), 'android', 'build.gradle'), 'utf8')
    expect(p.firebaseMessagingVersion(gradle)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(() => p.firebaseMessagingVersion('nothing here')).toThrow(/firebase-messaging/)
  })
  it('manifest:登记我们的服务(MESSAGING_EVENT、不导出),移除 expo 自带的那个;POST_NOTIFICATIONS;重复打补丁不重复加', () => {
    const m = p.patchManifest(p.patchManifest(manifest()))
    const app = m.manifest.application[0]
    expect(m.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools')
    const ours = app.service.filter((s: any) => s.$['android:name'] === p.SERVICE)
    expect(ours).toHaveLength(1)
    expect(ours[0].$['android:exported']).toBe('false')
    expect(ours[0]['intent-filter'][0].action[0].$['android:name']).toBe('com.google.firebase.MESSAGING_EVENT')
    expect(app.service.filter((s: any) => s.$['android:name'] === p.EXPO_SERVICE && s.$['tools:node'] === 'remove')).toHaveLength(1)
    expect(m.manifest['uses-permission'].filter((u: any) => u.$['android:name'] === 'android.permission.POST_NOTIFICATIONS')).toHaveLength(1)
  })
  it('app/build.gradle:加一次 firebase-messaging 依赖', () => {
    const base = 'dependencies {\n    implementation("com.facebook.react:react-android")\n}\n'
    const once = p.patchAppGradle(base, '24.1.0')
    expect(p.patchAppGradle(once, '24.1.0')).toBe(once)
    expect(once).toContain('implementation "com.google.firebase:firebase-messaging:24.1.0"')
  })
  it('EXPO_SERVICE 就是 expo-notifications manifest 里登记的那个类', () => {
    const xml = readFileSync(join(dirname(require.resolve('expo-notifications/package.json')), 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
    expect(xml).toContain(p.EXPO_SERVICE)
  })
})
```

`apps/app/plugins/native-guards.test.ts` 追加:

```ts
describe('expo-secure-store 的安卓存储格式(TendhearthMessagingService 按它读推送密钥)', () => {
  const dir = join(pkgDir('expo-secure-store'), 'android', 'src', 'main', 'java', 'expo', 'modules', 'securestore')
  const mod = read(dir, 'SecureStoreModule.kt')
  const aes = read(dir, 'encryptors', 'AESEncryptor.kt')
  it('SharedPreferences「SecureStore」,键 = "<service>-<key>",记录里有 scheme', () => {
    expect(mod).toContain('SHARED_PREFERENCES_NAME = "SecureStore"')
    expect(mod).toContain('return "$keychainService-$key"')
    expect(mod).toContain('encryptedItem.put(SCHEME_PROPERTY, AESEncryptor.NAME)')
  })
  it('AES/GCM,Keystore 别名 = "AES/GCM/NoPadding:<service>:keystoreUnauthenticated",字段 ct / iv / tlen', () => {
    expect(aes).toContain('AES_CIPHER = "AES/GCM/NoPadding"')
    expect(aes).toContain('return "$AES_CIPHER:$baseAlias"')
    expect(aes).toContain('return "${getKeyStoreAlias(options)}:$suffix"')
    expect(mod).toContain('UNAUTHENTICATED_KEYSTORE_SUFFIX = "keystoreUnauthenticated"')
    expect(aes).toContain('CIPHERTEXT_PROPERTY = "ct"')
    expect(aes).toContain('IV_PROPERTY = "iv"')
    expect(aes).toContain('GCM_AUTHENTICATION_TAG_LENGTH_PROPERTY = "tlen"')
    expect(aes).toContain('NAME = "aes"')
  })
  it('Kotlin 读取端用的常量与 key-store.ts 一致', () => {
    const reader = read(here, '..', 'native', 'android-push', 'android', 'SecureStoreReader.kt')
    expect(reader).toContain(`SERVICE = "${PUSH_KEY_SERVICE}"`)
    expect(reader).toContain(`ITEM = "${PUSH_KEY_ITEM}"`)
    expect(reader).toContain('"AES/GCM/NoPadding:$SERVICE:keystoreUnauthenticated"')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -8; cd ../..`
Expected: FAIL(占位插件没有这些导出;`SecureStoreReader.kt` 不存在)。

- [ ] **Step 3: 实现**

`apps/app/native/android-push/android/SecureStoreReader.kt`:

```kotlin
package com.tendhearth.app.push

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * 读 app 经 expo-secure-store(57.x)写下的推送密钥记录(src/push/key-store.ts)。消息服务与 app 同一进程、同一 UID,
 * 能读同一份 SharedPreferences 与 AndroidKeyStore。格式由 apps/app/plugins/native-guards.test.ts 钉住;读不出 ⇒ null(显示占位)。
 */
object SecureStoreReader {
  private const val PREFS = "SecureStore"
  private const val SERVICE = "tendhearth.push"
  private const val ITEM = "tendhearth.pushkey.v1"
  private const val ALIAS = "AES/GCM/NoPadding:$SERVICE:keystoreUnauthenticated"

  fun readPushKeyRecord(ctx: Context): String? = try {
    val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("$SERVICE-$ITEM", null)
    if (raw == null) null else {
      val item = JSONObject(raw)
      if (item.optString("scheme") != "aes") null else {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
        if (key == null) null else {
          val c = Cipher.getInstance("AES/GCM/NoPadding")
          c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(item.getInt("tlen"), Base64.decode(item.getString("iv"), Base64.DEFAULT)))
          String(c.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT)), Charsets.UTF_8)
        }
      }
    }
  } catch (e: Exception) {
    null
  }
}
```

`apps/app/native/android-push/android/TendhearthMessagingService.kt`:

```kotlin
package com.tendhearth.app.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tendhearth.app.R
import org.json.JSONObject
import java.util.Locale

/**
 * 安卓消息服务(spec §7):中继发 FCM data message(HIGH),密文在 data.wcc(JSON 字符串)。这里解密、去重、按种类发本地通知。
 * 解不开 ⇒ 中性占位;重复 ⇒ 不再提醒。点通知 ⇒ tendhearth://push-open 深链(app 端校验参数、先拉详情)。从不记录明文、密钥、密文或 token。
 * 取代 expo-notifications 自带的消息服务(manifest 里移除了它,见 plugins/with-android-push.js);token 刷新由 app 每次上线时重查补上。
 */
class TendhearthMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val wcc = message.data["wcc"] ?: return
    val now = System.currentTimeMillis()
    val record = SecureStoreReader.readPushKeyRecord(applicationContext)?.let { PushKeyRecord.parse(it) }
    val lang = PushPresenter.lang(record?.lang, Locale.getDefault().toLanguageTag())
    val strings = PushStrings.table
    val result = if (record == null) PushOpenResult.Failure(PushOpenError.MALFORMED) else PushCrypto.open(record.key, wcc, now)
    val display = if (result is PushOpenResult.Ok) {
      val msg = PushMessage.parse(result.payload)
      if (msg == null) PushPresenter.placeholder(lang, strings)
      else {
        if (seen(PushDedupe.key(msg.ts, result.ct), now)) return
        PushPresenter.display(msg, lang, strings)
      }
    } else PushPresenter.placeholder(lang, strings)
    post(display, lang)
  }

  override fun onNewToken(token: String) {
    // 不存、不记:app 下次上线 / 回前台时 syncPush 会拿到新 token 并重登(src/push/register.ts)。
  }

  private fun seen(key: String, now: Long): Boolean {
    val prefs = getSharedPreferences("tendhearth.push.dedupe", Context.MODE_PRIVATE)
    val saved = try { JSONObject(prefs.getString("entries", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
    val store = PushDedupe(saved.keys().asSequence().associateWith { saved.optLong(it) })
    val dup = store.seen(key, now)
    prefs.edit().putString("entries", JSONObject(store.snapshot()).toString()).apply()
    return dup
  }

  private fun ensureChannels(nm: NotificationManager, lang: String) {
    if (Build.VERSION.SDK_INT < 26) return
    val s = PushStrings.table[lang] ?: PushStrings.table.getValue("en")
    if (nm.getNotificationChannel("decide") == null) nm.createNotificationChannel(NotificationChannel("decide", s.getValue("channel.decide"), NotificationManager.IMPORTANCE_HIGH))
    if (nm.getNotificationChannel("updates") == null) nm.createNotificationChannel(NotificationChannel("updates", s.getValue("channel.updates"), NotificationManager.IMPORTANCE_DEFAULT))
  }

  private fun post(d: PushDisplay, lang: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannels(nm, lang)
    val intent = if (d.deepLink != null) Intent(Intent.ACTION_VIEW, Uri.parse(d.deepLink)).setPackage(packageName)
      else packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pi = PendingIntent.getActivity(this, d.notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, d.channel) else Notification.Builder(this)
    val n = b.setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(d.title)
      .setContentText(d.body)
      .setStyle(Notification.BigTextStyle().bigText(d.body))
      .setAutoCancel(true)
      .setContentIntent(pi)
      .build()
    try { nm.notify(d.notificationId, n) } catch (e: SecurityException) { /* 安卓 13+ 没给通知权限:系统不显示,app 设置页会提示 */ }
  }
}
```

`apps/app/plugins/with-android-push.js`(整份替换占位):

```js
// 安卓消息服务(spec §7):prebuild 时把 native/android-push 的核心与服务拷进 android/app,登记服务、移除 expo 自带的消息服务、
// 加 firebase-messaging 依赖(版本取 expo-notifications 自己用的那个)与 POST_NOTIFICATIONS。android/ 不进 git;重复 prebuild 幂等。
const fs = require('fs')
const path = require('path')
const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins')
const { loadStrings, kotlinSource } = require('./push-strings')

const SERVICE = '.push.TendhearthMessagingService'
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'
const NATIVE = path.join(__dirname, '..', 'native', 'android-push')
const CORE = path.join(NATIVE, 'src', 'main', 'kotlin', 'com', 'tendhearth', 'app', 'push')
const ANDROID_ONLY = path.join(NATIVE, 'android')
const MARK = '// tendhearth: firebase-messaging for TendhearthMessagingService'

function firebaseMessagingVersion(gradleText) {
  const m = /firebase-messaging:([0-9][0-9.]*)/.exec(gradleText)
  if (!m) throw new Error('with-android-push: 在 expo-notifications 的 android/build.gradle 里找不到 firebase-messaging 版本')
  return m[1]
}

function expoNotificationsGradle() {
  const dir = path.dirname(require.resolve('expo-notifications/package.json', { paths: [path.join(__dirname, '..')] }))
  return fs.readFileSync(path.join(dir, 'android', 'build.gradle'), 'utf8')
}

function patchManifest(m) {
  const root = m.manifest
  root.$ = root.$ || {}
  root.$['xmlns:tools'] = 'http://schemas.android.com/tools'
  root['uses-permission'] = root['uses-permission'] || []
  if (!root['uses-permission'].some(u => u.$['android:name'] === 'android.permission.POST_NOTIFICATIONS')) {
    root['uses-permission'].push({ $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } })
  }
  const app = root.application[0]
  app.service = (app.service || []).filter(s => s.$['android:name'] !== SERVICE && s.$['android:name'] !== EXPO_SERVICE)
  app.service.push({
    $: { 'android:name': SERVICE, 'android:exported': 'false' },
    'intent-filter': [{ $: { 'android:priority': '10' }, action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] }],
  })
  app.service.push({ $: { 'android:name': EXPO_SERVICE, 'tools:node': 'remove' } })
  return m
}

function patchAppGradle(text, version) {
  if (text.includes(MARK)) return text
  return text.replace(/dependencies\s*\{/, `dependencies {\n    ${MARK}\n    implementation "com.google.firebase:firebase-messaging:${version}"`)
}

function copySources(androidRoot) {
  const dest = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'tendhearth', 'app', 'push')
  fs.mkdirSync(dest, { recursive: true })
  for (const dir of [CORE, ANDROID_ONLY]) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.kt'))) fs.copyFileSync(path.join(dir, f), path.join(dest, f))
  }
  fs.writeFileSync(path.join(dest, 'PushStrings.kt'), kotlinSource(loadStrings()))
}

function withAndroidPush(config) {
  config = withDangerousMod(config, ['android', c => { copySources(c.modRequest.platformProjectRoot); return c }])
  config = withAndroidManifest(config, c => { c.modResults = patchManifest(c.modResults); return c })
  config = withAppBuildGradle(config, c => {
    c.modResults.contents = patchAppGradle(c.modResults.contents, firebaseMessagingVersion(expoNotificationsGradle()))
    return c
  })
  return config
}

module.exports = withAndroidPush
module.exports.SERVICE = SERVICE
module.exports.EXPO_SERVICE = EXPO_SERVICE
module.exports.firebaseMessagingVersion = firebaseMessagingVersion
module.exports.patchManifest = patchManifest
module.exports.patchAppGradle = patchAppGradle
```

(Task 7 Step 1 若发现 expo 的服务类名不同,改 `EXPO_SERVICE`;测试会核对。)

图标(本机 Pillow,只用已验收的 CC 素材):

```bash
python3 - <<'PY'
from PIL import Image
cc = Image.open('apps/app/assets/cc/lit.png').convert('RGBA')
cc = cc.crop(cc.getbbox())
alpha = cc.split()[3]
white = Image.new('RGBA', cc.size, (255, 255, 255, 255))
white.putalpha(alpha)                                   # 白色剪影,保留素材的透明度
def place(size, frac):
    base = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    w, h = white.size
    k = int(size * frac) / max(w, h)
    fig = white.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
    base.alpha_composite(fig, ((size - fig.width) // 2, (size - fig.height) // 2))
    return base
place(432, 0.50).save('apps/app/assets/images/android-icon-monochrome.png', optimize=True)   # 自适应图标安全区约 66%
place(96, 0.80).save('apps/app/assets/images/notification-icon.png', optimize=True)         # expo-notifications 要 96×96 白色透明底
PY
file apps/app/assets/images/android-icon-monochrome.png apps/app/assets/images/notification-icon.png
```
Expected:432×432 与 96×96 RGBA。用 Read 看两张:白色 CC 轮廓居中、没被裁。若 CC 素材的透明边缘让剪影成了一团看不出形状的白块,**不替换单色图**(保留模板图并在 README 的「主人要做的」写「单色图待 Codex 出稿」),通知小图标仍用生成的这张。

- [ ] **Step 4: 跑测试 + 生成检查(本机没有安卓 SDK,只能核对生成的文件)**

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
bunx expo prebuild --platform android --clean --no-install; echo prebuild=$?
ls android/app/src/main/java/com/tendhearth/app/push/
grep -n "TendhearthMessagingService\|ExpoFirebaseMessagingService\|POST_NOTIFICATIONS" android/app/src/main/AndroidManifest.xml
grep -n "firebase-messaging" android/app/build.gradle
ls android/app/src/main/res/drawable*/notification_icon.png
cd ../..
```
Expected:`app=0`、`prebuild=0`;目录里有 6 个核心 `.kt` + 2 个服务 `.kt` + `PushStrings.kt`;manifest 里我们的服务一条、expo 的服务带 `tools:node="remove"`、权限一条;gradle 一行依赖;`notification_icon.png` 存在。
Kotlin 服务本身**本机编不了**(没有安卓 SDK / adb):真编译在主人的 EAS 安卓构建里(见文末)。

- [ ] **Step 5: Commit**

```bash
git add apps/app/native/android-push/android apps/app/plugins apps/app/assets/images
git status --short   # 确认没有 android/
git commit -m "app 推送:安卓消息服务(Kotlin,读 expo-secure-store 的推送密钥)+ config plugin + 通知小图标与单色图

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: app 接线 —— 登记生命周期、撤销 / 解除配对清推送密钥、设置里的通知一节

**Files:**
- Create: `apps/app/src/push/native.ts`、`apps/app/src/push/PushProvider.tsx`、`apps/app/src/view/notifications.ts`
- Modify: `apps/app/src/state/session-store.ts`、`apps/app/src/state/session.tsx`、`apps/app/src/app/_layout.tsx`、`apps/app/src/app/settings.tsx`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`
- Test: `apps/app/src/state/session-store.test.ts`、`apps/app/src/view/notifications.test.ts`、`apps/app/src/push/push-state.test.ts`

**Interfaces:**
- Consumes:`syncPush`、`shouldSync`、`permState`、`PushStatus`(Task 5);`makePushKeyStore`、`PUSH_KEY_SERVICE`(Task 5);`Backend.registerPush` / `testPush`。
- Produces:
  - `session-store.ts`:`clearStored(store: CredentialStore, push: { clear(): Promise<void> }, log?): Promise<void>`(配对清失败 ⇒ 抛;推送清失败 ⇒ 只记一行);`leftoverPushKey(ready: boolean, pairing: PairingRecord | null): boolean`
  - `SessionProvider` 新增 prop `push: { clear(): Promise<void> }`
  - `native.ts`:`pushKeys: PushKeyStore`、`apnsEnv`、`perms: { get(); request() }`、`nativeToken()`、`prepareChannels(lang)`、`registerCategories()`、`openSystemSettings()`
  - `PushProvider.tsx`:`<PushProvider>`、`usePush(): { status: PushStatus; openSettings(): void; sendTest(): Promise<{ ok: boolean; code: string }> }`
  - `view/notifications.ts`:`notificationNoticeKey(status: PushStatus): MessageKey`

- [ ] **Step 1: 写失败的测试**

`apps/app/src/state/session-store.test.ts` 追加:

```ts
import { clearStored, leftoverPushKey } from './session-store'

describe('撤销 / 解除配对:推送密钥一起清(spec §3「设备被撤销」、§4)', () => {
  it('两条都清;推送那条清失败只记一行、不连累配对', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const store = { clear: async () => { calls.push('pairing') } } as any
    await clearStored(store, { clear: async () => { calls.push('push'); throw Object.assign(new Error('x'), { code: 'E_KEYCHAIN' }) } }, l => logs.push(l))
    expect(calls.sort()).toEqual(['pairing', 'push'])
    expect(logs).toEqual(['pushClear failed (E_KEYCHAIN)'])
  })
  it('配对那条清失败 ⇒ 抛(设置页据此提示「没能清掉」),推送那条照样清', async () => {
    const calls: string[] = []
    const store = { clear: async () => { throw new Error('nope') } } as any
    await expect(clearStored(store, { clear: async () => { calls.push('push') } }, () => {})).rejects.toThrow('nope')
    expect(calls).toEqual(['push'])
  })
  it('leftoverPushKey:会话读完、没有配对 ⇒ 该清(上次清失败 / 从老版本升级)', () => {
    expect(leftoverPushKey(true, null)).toBe(true)
    expect(leftoverPushKey(false, null)).toBe(false)
    expect(leftoverPushKey(true, { deviceId: 'ab12cd34' } as any)).toBe(false)
  })
})
```

`apps/app/src/view/notifications.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { notificationNoticeKey } from './notifications'
import { t } from '../i18n'

describe('设置页的通知状态', () => {
  it('每种状态一句话,两种语言都有', () => {
    for (const s of ['idle', 'registered', 'denied', 'unavailable', 'offline', 'failed'] as const) {
      const k = notificationNoticeKey(s)
      expect(t('en', k).length, s).toBeGreaterThan(0)
      expect(t('zh-Hans', k).length, s).toBeGreaterThan(0)
    }
    expect(notificationNoticeKey('denied')).toBe('settings.notifDenied')
    expect(notificationNoticeKey('unavailable')).toBe('settings.notifUnavailable')
  })
})
```

`apps/app/src/push/push-state.test.ts`(PushProvider 里的决定抽成纯函数 `nextSyncAction`,放在 `register.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { nextSyncAction } from './register'

describe('nextSyncAction —— PushProvider 什么时候跑 syncPush', () => {
  it('不是真连接 / 没配对 ⇒ 什么都不做', () => {
    expect(nextSyncAction({ live: false, conn: 'online', status: 'idle', trigger: 'online' })).toBe('none')
  })
  it('上线:没登记成功就跑;离线时不跑', () => {
    expect(nextSyncAction({ live: true, conn: 'online', status: 'idle', trigger: 'online' })).toBe('sync')
    expect(nextSyncAction({ live: true, conn: 'online', status: 'registered', trigger: 'online' })).toBe('none')
    expect(nextSyncAction({ live: true, conn: 'offline', status: 'idle', trigger: 'online' })).toBe('none')
  })
  it('回前台:刚在系统设置里打开了通知(denied)⇒ 跑;在线才跑', () => {
    expect(nextSyncAction({ live: true, conn: 'online', status: 'denied', trigger: 'foreground' })).toBe('sync')
    expect(nextSyncAction({ live: true, conn: 'connecting', status: 'denied', trigger: 'foreground' })).toBe('none')
  })
  it('token 变了 ⇒ 强制重登(在线时);撤销后什么都不做', () => {
    expect(nextSyncAction({ live: true, conn: 'online', status: 'registered', trigger: 'token' })).toBe('force')
    expect(nextSyncAction({ live: true, conn: 'revoked', status: 'registered', trigger: 'token' })).toBe('none')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -8; cd ../..`
Expected: FAIL(`clearStored`、`notificationNoticeKey`、`nextSyncAction` 不存在)。

- [ ] **Step 3: 实现纯逻辑**

`apps/app/src/state/session-store.ts` 末尾加:

```ts
/** 撤销 / 解除配对:配对记录与推送密钥一起清(spec §3)。推送那条失败只记一行;配对那条失败照样抛给调用方。 */
export async function clearStored(store: CredentialStore, push: { clear(): Promise<void> }, log: Log = devLog): Promise<void> {
  const [p] = await Promise.allSettled([store.clear(), push.clear().catch(e => log(`pushClear failed (${kind(e)})`))])
  if (p.status === 'rejected') throw p.reason
}

/** 会话读完却没有配对 ⇒ 钥匙串里若还留着推送密钥就该清(上次清失败 / 老版本升级上来)。 */
export function leftoverPushKey(ready: boolean, pairing: PairingRecord | null): boolean {
  return ready && pairing === null
}
```

`apps/app/src/push/register.ts` 末尾加:

```ts
/** PushProvider 的调度:只在真连接、在线时跑;token 变了强制重登。 */
export function nextSyncAction(s: { live: boolean; conn: 'connecting' | 'online' | 'offline' | 'revoked'; status: PushStatus; trigger: 'online' | 'foreground' | 'token' }): 'none' | 'sync' | 'force' {
  if (!s.live || s.conn !== 'online') return 'none'
  if (!shouldSync(s.status, s.trigger)) return 'none'
  return s.trigger === 'token' ? 'force' : 'sync'
}
```

`apps/app/src/view/notifications.ts`:

```ts
import type { MessageKey } from '../i18n'
import type { PushStatus } from '../push/register'

export function notificationNoticeKey(status: PushStatus): MessageKey {
  switch (status) {
    case 'registered': return 'settings.notifOn'
    case 'denied': return 'settings.notifDenied'
    case 'unavailable': return 'settings.notifUnavailable'
    case 'offline': return 'settings.notifOffline'
    case 'failed': return 'settings.notifFailed'
    default: return 'settings.notifPending'
  }
}
```

(若 `src/i18n/index.ts` 导出的键类型不叫 `MessageKey`,先 `grep -n "export type" apps/app/src/i18n/index.ts` 用实际名字。)

文案 —— `en.ts`:

```ts
  'settings.notifications': 'Notifications',
  'settings.notifOn': 'On. CC will let you know when something needs you.',
  'settings.notifDenied': 'Notifications are off for Tendhearth.',
  'settings.notifOpenSettings': 'Open system settings',
  'settings.notifUnavailable': 'Your computer isn’t using the Tendhearth relay yet, so notifications can’t reach this phone.',
  'settings.notifOffline': 'Notifications will finish setting up when your computer is reachable.',
  'settings.notifFailed': 'Couldn’t set up notifications. We’ll try again next time.',
  'settings.notifPending': 'Setting up notifications…',
  'settings.notifTest': 'Send a test notification',
  'settings.notifTestSent': 'Sent. It should arrive in a few seconds.',
  'settings.notifTestFailed': 'Couldn’t send it ({code}).',
```

`zh-Hans.ts`:

```ts
  'settings.notifications': '通知',
  'settings.notifOn': '已开启:有事需要你时,CC 会告诉你。',
  'settings.notifDenied': 'Tendhearth 的通知已关闭。',
  'settings.notifOpenSettings': '去系统设置',
  'settings.notifUnavailable': '你的电脑还没用上 Tendhearth 中继,通知暂时到不了这台手机。',
  'settings.notifOffline': '等电脑连得上,通知会自动设好。',
  'settings.notifFailed': '通知没设好,下次打开时再试。',
  'settings.notifPending': '正在设置通知…',
  'settings.notifTest': '发一条测试通知',
  'settings.notifTestSent': '已发出,几秒内应该会到。',
  'settings.notifTestFailed': '没发出去({code})。',
```

- [ ] **Step 4: 跑纯逻辑测试,确认通过**

Run: `cd apps/app && bun run test; echo $?; cd ../..`
Expected: `0`。

- [ ] **Step 5: RN 接线**

`apps/app/src/push/native.ts`:

```ts
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Linking, Platform } from 'react-native'
import { t, type Lang } from '../i18n'
import { makePushKeyStore, PUSH_KEY_SERVICE } from './key-store'
import { permState, type PermissionState } from './register'

// expo-notifications 与钥匙串的真实例。纯逻辑在 register.ts / key-store.ts。

const extra = (Constants.expoConfig?.extra ?? {}) as { apnsEnv?: string; keychainGroup?: string }
export const apnsEnv: 'development' | 'production' = extra.apnsEnv === 'production' ? 'production' : 'development'

export const pushKeys = makePushKeyStore(SecureStore, {
  shared: {
    keychainService: PUSH_KEY_SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,   // 扩展要在锁屏后(首次解锁之后)读
    ...(Platform.OS === 'ios' && typeof extra.keychainGroup === 'string' ? { accessGroup: extra.keychainGroup } : {}),
  },
  local: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
})

export const perms = {
  get: async (): Promise<PermissionState> => permState(await Notifications.getPermissionsAsync()),
  request: async (): Promise<PermissionState> => permState(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
}

export async function nativeToken(): Promise<string> {
  const tok = await Notifications.getDevicePushTokenAsync()
  if (typeof tok.data !== 'string') throw new Error('token_shape')
  return tok.data
}

/** 安卓:与 Kotlin 服务同样的两个渠道 id、同样的名字(plugins/push-strings.test.ts 钉住)。 */
export async function prepareChannels(lang: Lang): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('decide', { name: t(lang, 'push.channelDecide'), importance: Notifications.AndroidImportance.HIGH })
  await Notifications.setNotificationChannelAsync('updates', { name: t(lang, 'push.channelUpdates'), importance: Notifications.AndroidImportance.DEFAULT })
}

/** iOS:扩展设的 category 都在这里注册,不带任何动作(通知本身从不执行操作)。 */
export async function registerCategories(): Promise<void> {
  if (Platform.OS !== 'ios') return
  for (const id of ['th.approval', 'th.question', 'th.done', 'th.failed', 'th.test']) await Notifications.setNotificationCategoryAsync(id, [])
}

export const openSystemSettings = () => { void Linking.openSettings() }

// app 在前台:不弹系统横幅,由 PushRouter 显示 app 自己的横幅(spec §7「正在用 app 时」);通知仍进通知中心。
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
})
```

`apps/app/src/push/PushProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Notifications from 'expo-notifications'
import { AppState, Platform } from 'react-native'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { leftoverPushKey, quietly } from '../state/session-store'
import { apnsEnv, nativeToken, openSystemSettings, perms, prepareChannels, pushKeys, registerCategories } from './native'
import { nextSyncAction, syncPush, type PushStatus } from './register'

type PushCtx = { status: PushStatus; openSettings(): void; sendTest(): Promise<{ ok: boolean; code: string }> }
const Ctx = createContext<PushCtx | null>(null)
const devLog = (l: string) => { if (__DEV__) console.log(`[push] ${l}`) } // 只有步骤名与错误码

// 推送登记的生命周期(spec §7「token 生命周期」):配对后 / 每次上线 / 回前台 / token 刷新;撤销与解除配对由会话清密钥。
export function PushProvider({ children }: { children: ReactNode }) {
  const { backend } = useBackendCtx()
  const session = useSession()
  const lang = useLang()
  const conn = useConnection()
  const [status, setStatus] = useState<PushStatus>('idle')
  const running = useRef(false)
  const pairing = session.pairing
  const live = backend.mode === 'live' && pairing !== null
  const statusRef = useRef(status)
  statusRef.current = status
  const connRef = useRef(conn.state)
  connRef.current = conn.state

  useEffect(() => { void registerCategories().catch(() => {}) }, [])
  useEffect(() => { if (leftoverPushKey(session.ready, pairing)) quietly(pushKeys.clear(), 'pushClear') }, [session.ready, pairing])
  // 配对了就先把密钥存好(离线也存):之后到的推送扩展照样能解。语言覆盖变了也更新记录。
  useEffect(() => { if (pairing) quietly(pushKeys.ensure(pairing.deviceToken, session.langOverride), 'pushEnsure') }, [pairing, session.langOverride])

  const run = useCallback(async (trigger: 'online' | 'foreground' | 'token') => {
    const action = nextSyncAction({ live, conn: connRef.current, status: statusRef.current, trigger })
    if (action === 'none' || running.current || !pairing) return
    running.current = true
    try {
      setStatus(await syncPush({
        os: Platform.OS === 'ios' ? 'ios' : 'android', apnsEnv, deviceId: pairing.deviceId, deviceToken: pairing.deviceToken,
        lang: session.langOverride, keys: pushKeys, permission: perms.get, requestPermission: perms.request,
        prepare: () => prepareChannels(lang), nativeToken, register: (p, tok) => backend.registerPush(p, tok),
        now: Date.now, log: devLog,
      }, { force: action === 'force' }))
    } catch (e) {
      devLog(`sync threw (${e instanceof Error ? e.name : 'unknown'})`)
      setStatus('failed')
    } finally {
      running.current = false
    }
  }, [live, pairing, session.langOverride, lang, backend])

  useEffect(() => { if (!live) setStatus('idle') }, [live])
  useEffect(() => { void run('online') }, [run, conn.state, conn.epoch])
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') void run('foreground') })
    return () => sub.remove()
  }, [run])
  useEffect(() => {
    const sub = Notifications.addPushTokenListener(() => { void run('token') })
    return () => sub.remove()
  }, [run])

  const value = useMemo<PushCtx>(() => ({
    status,
    openSettings: openSystemSettings,
    sendTest: () => backend.testPush(),
  }), [status, backend])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePush(): PushCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('PushProvider missing')
  return c
}
```

`apps/app/src/state/session.tsx`:
- import 改成 `import { clearStored, loadSession, quietly } from './session-store'`。
- `SessionProvider` 的 props 加 `push: { clear(): Promise<void> }`(签名:`{ children, store, push }: { children: ReactNode; store: CredentialStore; push: { clear(): Promise<void> } }`)。
- `dropStoredPairing() { quietly(clearStored(store, push), 'clear') },`
- `async forgetPairing() { await clearStored(store, push); setPairing(null); setSeen(false) },`
- `useMemo` 依赖数组加 `push`。

`apps/app/src/app/_layout.tsx`:
- import `pushKeys` from `'../push/native'`、`PushProvider` from `'../push/PushProvider'`。
- `<SessionProvider store={credentials} push={pushKeys}>`。
- 在 `<BackendProvider …>` 里面、`<ThemeProvider>` 外面包一层 `<PushProvider>`。

`apps/app/src/app/settings.tsx`:
- import `usePush` from `'../push/PushProvider'`、`notificationNoticeKey` from `'../view/notifications'`。
- 组件里 `const push = usePush()`、`const [testing, setTesting] = useState(false)`。
- 在「语言」一节之后、演示 / 配对相关各节之前(非演示才显示)加:

```tsx
        {!demo ? (
          <Card testID="settings-notifications" style={{ gap: space.s }}>
            {heading('settings.notifications')}
            <Text testID={`settings-notif-${push.status}`} style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{t(lang, notificationNoticeKey(push.status))}</Text>
            {push.status === 'denied' ? (
              <Button kind="secondary" testID="settings-notif-open" label={t(lang, 'settings.notifOpenSettings')} onPress={push.openSettings} />
            ) : null}
            {push.status === 'registered' ? (
              <Button kind="secondary" testID="settings-notif-test" label={t(lang, 'settings.notifTest')} busy={testing} disabled={testing}
                onPress={async () => {
                  setTesting(true)
                  try {
                    const r = await push.sendTest()
                    Alert.alert(r.ok ? t(lang, 'settings.notifTestSent') : t(lang, 'settings.notifTestFailed', { code: r.code }))
                  } catch (e) {
                    Alert.alert(t(lang, 'settings.notifTestFailed', { code: e instanceof Error ? e.message : 'unknown' }))
                  } finally { setTesting(false) }
                }} />
            ) : null}
          </Card>
        ) : null}
```

(`Card` / `Button` / `Alert` 已在文件里 import 的就不重复;没有就补上,路径同文件里其它组件。)

- [ ] **Step 6: 跑回路**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..`
Expected: `app=0`。

- [ ] **Step 7: 模拟器上看一眼(不联网的部分)**

```bash
cd apps/app && UDID=$(cat /tmp/th-push-udid)
bunx expo run:ios --device "$UDID"      # 重新生成 development build(加了 expo-notifications 与扩展)
maestro --device "$UDID" test .maestro/     # 已有的四个流程照样通过:演示模式不弹通知权限
cd ../..
```
Expected:四个流程全过。(设置里的通知一节只在真连接时出现;真配对后的权限弹框、登记、设置状态是主人真机验收项。)

- [ ] **Step 8: Commit**

```bash
git add apps/app/src
git commit -m "app 推送:登记生命周期(配对后 / 上线 / 回前台 / token 刷新)、撤销与解除配对清推送密钥、设置里的通知一节

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 点通知 —— 中转页、iOS 响应路由、前台横幅、开发用密钥页、Maestro

**Files:**
- Create: `apps/app/src/app/push-open.tsx`、`apps/app/src/app/dev-push-key.tsx`、`apps/app/src/push/PushRouter.tsx`、`apps/app/src/ui/PushBanner.tsx`
- Create: `apps/app/.maestro/push-open.yaml`
- Modify: `apps/app/src/app/_layout.tsx`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`

**Interfaces:**
- Consumes:`resolvePushRoute`、`hrefFor`、`pushOpenHref`(Task 6);`targetFromParams`、`targetFromNotification`(Task 6);`bannerFrom`、`Banner`(Task 6);`pushKeys`(Task 9);`isDevPushToken`(Task 5)。
- Produces:路由 `/push-open?kind=&taskId=&requestId=`(安卓深链与 iOS 响应共用);`/dev-push-key?token=dev…`(只在 `__DEV__` 生效,Task 11 用);testID:`push-opening`、`push-gone`、`push-go-now`、`push-banner`、`dev-push-key-ok`。

- [ ] **Step 1: 文案**

`en.ts`:`'push.opening': 'Opening…',`、`'push.gone': 'That item is no longer on your computer.',`、`'push.goNow': 'Go to Now',`、`'push.bannerOpen': 'Open',`
`zh-Hans.ts`:`'push.opening': '正在打开…',`、`'push.gone': '这件事在电脑上已经不在了。',`、`'push.goNow': '回到此刻',`、`'push.bannerOpen': '打开',`

- [ ] **Step 2: 中转页**

`apps/app/src/app/push-open.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { hrefFor, resolvePushRoute } from '../push/route'
import { targetFromParams } from '../push/target'
import { useBackendCtx } from '../state/BackendProvider'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'

// 点通知 / 深链进来的中转页(spec §7「点通知」、§3「旧通知」):先按 taskId 拉一次最新详情;事情已经不在 ⇒ 留在这里说一句;
// 否则先垫一个「此刻」再推批准页 / 进展页(返回键回到此刻),那两页打开时还会再拉新。这一页从不提交任何东西。
export default function PushOpen() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const { backend } = useBackendCtx()
  const { seenWelcome } = useSession()
  const [gone, setGone] = useState(false)
  const key = JSON.stringify(params)

  useEffect(() => {
    if (!seenWelcome) { router.replace('/welcome'); return }
    let alive = true
    const target = targetFromParams(JSON.parse(key) as Record<string, string | string[]>)
    void resolvePushRoute(target, id => backend.matter(id, lang)).then(r => {
      if (!alive) return
      if (r.kind === 'gone') { setGone(true); return }
      router.replace('/')
      const href = hrefFor(r)
      if (href !== '/') router.push(href)
    })
    return () => { alive = false }
    // 语言变了不重新路由
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backend, seenWelcome, router])

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1, padding: space.xl, gap: space.l, justifyContent: 'center' }}>
        {gone ? (
          <>
            <Text testID="push-gone" accessibilityLiveRegion="polite" style={{ color: c.ink, fontSize: 18, lineHeight: 26 }}>{t(lang, 'push.gone')}</Text>
            <Button kind="primary" testID="push-go-now" label={t(lang, 'push.goNow')} onPress={() => router.replace('/')} />
          </>
        ) : (
          <Text testID="push-opening" style={{ color: c.muted, fontSize: 16 }}>{t(lang, 'push.opening')}</Text>
        )}
      </View>
    </SafeAreaView>
  )
}
```

- [ ] **Step 3: iOS 响应路由 + 前台横幅**

`apps/app/src/ui/PushBanner.tsx`:

```tsx
import { useEffect } from 'react'
import { Pressable, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Banner } from '../push/banner'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// app 在前台时自己的横幅(spec §7):不动画(减少动态效果也一样),6 秒后自己收起;点一下去中转页。
export function PushBanner({ banner, onOpen, onClose, openLabel }: { banner: Banner; onOpen(): void; onClose(): void; openLabel: string }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  useEffect(() => { const id = setTimeout(onClose, 6000); return () => clearTimeout(id) }, [banner, onClose])
  return (
    <Pressable testID="push-banner" accessibilityRole="button" accessibilityLabel={`${banner.title}. ${banner.body}. ${openLabel}`} onPress={onOpen}
      style={{ position: 'absolute', top: insets.top + space.s, left: space.l, right: space.l, padding: space.l, gap: space.xs,
        borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.card }}>
      <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{banner.title}</Text>
      <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }} numberOfLines={2}>{banner.body}</Text>
    </Pressable>
  )
}
```

`apps/app/src/push/PushRouter.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { derivePushKey } from '@wechat-cc/protocol'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useSession } from '../state/session'
import { PushBanner } from '../ui/PushBanner'
import { bannerFrom, type Banner } from './banner'
import { pushOpenHref } from './route'
import { targetFromNotification } from './target'

// iOS:点通知(冷启动 / 后台 / 前台)⇒ 中转页。安卓的点击走 Kotlin 服务发的深链,直接到中转页,不经过这里。
// 扩展没解开时,用配对记录里的设备令牌在 app 里兜底解一次(时间用通知送达时刻)。
export function PushRouter() {
  const router = useRouter()
  const lang = useLang()
  const { pairing } = useSession()
  const last = Notifications.useLastNotificationResponse()
  const handled = useRef(new Set<string>())
  const [banner, setBanner] = useState<Banner | null>(null)
  const key = useMemo(() => (pairing ? derivePushKey(pairing.deviceToken) : null), [pairing])

  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const id = last.notification.request.identifier
    if (handled.current.has(id)) return
    handled.current.add(id)
    const target = targetFromNotification(last.notification, key ? { key, now: last.notification.date } : undefined)
    router.push(target ? pushOpenHref(target) : '/')
  }, [last, key, router])

  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(n => {
      setBanner(bannerFrom(n, lang, key ? { key, now: n.date } : undefined))
    })
    return () => sub.remove()
  }, [lang, key])

  const close = useCallback(() => setBanner(null), [])
  if (!banner) return null
  return (
    <PushBanner banner={banner} openLabel={t(lang, 'push.bannerOpen')} onClose={close}
      onOpen={() => { const b = banner; setBanner(null); router.push(b.target ? pushOpenHref(b.target) : '/') }} />
  )
}
```

(Task 7 Step 1 若确认 `Notification.date` 是秒,两处 `now:` 乘 1000。)

`apps/app/src/app/_layout.tsx`:import `PushRouter`;在 `<Stack>…</Stack>` 之后、`</ThemeProvider>` 之前放 `<PushRouter />`;`Stack` 里加 `<Stack.Screen name="push-open" options={{ gestureEnabled: false }} />`。

- [ ] **Step 4: 开发构建专用的密钥页(Task 11 用)**

`apps/app/src/app/dev-push-key.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { isDevPushToken } from '../push/key-store'
import { pushKeys } from '../push/native'

// 只在开发构建里生效:把一个合成的开发令牌(dev + 48 位 hex,和真设备令牌的形状不同)推出的推送密钥存进共享钥匙串,
// 让 scripts/sim-push.ts 在模拟器上验证通知扩展。发布构建里 __DEV__ 为 false ⇒ 直接回此刻,什么都不存。
export default function DevPushKey() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const [state, setState] = useState<'pending' | 'ok' | 'failed' | 'rejected'>('pending')
  useEffect(() => {
    if (!__DEV__) return
    if (typeof token !== 'string' || !isDevPushToken(token)) { setState('rejected'); return }
    void pushKeys.ensure(token, null).then(() => setState('ok'), () => setState('failed'))
  }, [token])
  if (!__DEV__) return <Redirect href="/" />
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><Text testID={`dev-push-key-${state}`}>{state}</Text></View>
}
```

- [ ] **Step 5: Maestro(演示模式,深链走中转页)**

`apps/app/.maestro/push-open.yaml`:

```yaml
# 点通知路由(演示模式,不需要真推送):中转页先拉详情 → 批准页钉住那条请求 → 返回回到此刻;
# 事情不在 ⇒ 「这件事在电脑上已经不在了」+ 回到此刻;伪造的参数 ⇒ 回此刻。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- tapOn:
    id: welcome-look-first
- extendedWaitUntil:
    visible:
      id: now-needs-you-card
    timeout: 10000
- openLink: tendhearth://push-open?kind=permission&taskId=a1b2c3d4&requestId=perm-demo-1
- extendedWaitUntil:
    visible:
      id: approval-title
    timeout: 10000
- assertVisible:
    id: approval-raw-inline
- tapOn:
    id: topbar-back
- extendedWaitUntil:
    visible:
      id: now-needs-you-card
    timeout: 10000
- openLink: tendhearth://push-open?kind=task_done&taskId=ffffffff
- extendedWaitUntil:
    visible:
      id: push-gone
    timeout: 10000
- assertVisible:
    text: "这件事在电脑上已经不在了。|That item is no longer on your computer\\."
- tapOn:
    id: push-go-now
- extendedWaitUntil:
    visible:
      id: now-needs-you-card
    timeout: 10000
- openLink: tendhearth://push-open?kind=permission&taskId=..%2F..%2Fx
- extendedWaitUntil:
    visible:
      id: now-needs-you-card
    timeout: 10000
```

(`topbar-back` 是批准页顶栏返回键的 testID(`src/ui/TopBar.tsx`);中转页用 replace('/') 再 push,所以返回回到此刻。)

- [ ] **Step 6: 回路 + 模拟器**

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
UDID=$(cat /tmp/th-push-udid)
bunx expo start --dev-client &   # 或另开终端;已装的 development build 连它
maestro --device "$UDID" test .maestro/push-open.yaml; echo maestro=$?
maestro --device "$UDID" test .maestro/; echo all=$?
cd ../..
```
Expected: `app=0`、`maestro=0`、`all=0`。(`expo start` 用 `run_in_background` 起,跑完停掉。)

- [ ] **Step 7: Commit**

```bash
git add apps/app/src apps/app/.maestro/push-open.yaml
git commit -m "app 推送:点通知中转页(先拉详情,事情不在另有说法)、iOS 响应路由与前台横幅、开发用密钥页、Maestro 路由流程

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 本机模拟器端到端 —— 真密文经 `xcrun simctl push` 走通扩展与点击

**Files:**
- Create: `apps/app/scripts/sim-push-lib.ts`、`apps/app/scripts/sim-push.ts`
- Test: `apps/app/scripts/sim-push-lib.test.ts`
- Modify: `apps/app/README.md`(推送一节补「怎么在模拟器上验」)

**Interfaces:**
- Consumes:协议包 `derivePushKey`、`sealPush`、`openPush`、`PushPlaintext`、`b64uEncode`、`b64uDecode`;`RELAY_PLACEHOLDER_BODY`(Task 6);`/dev-push-key`(Task 10)。
- Produces:`devToken(seed: string): string`;`buildSimPush(o: { token: string; mode: 'ok' | 'stale' | 'tamper' | 'wrong-key'; kind: PushKindT; taskId?: string; requestId?: string; body: string; now: number }): { aps: …; wcc: SealedPush }`;CLI `bun apps/app/scripts/sim-push.ts [--udid] [--seed] [--kind] [--task] [--request] [--body] [--mode] [--repeat] [--print-link]`。

- [ ] **Step 1: 写失败的测试**

`apps/app/scripts/sim-push-lib.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { derivePushKey, openPush, PushPlaintext } from '@wechat-cc/protocol'
import { buildSimPush, devToken } from './sim-push-lib'
import { isDevPushToken } from '../src/push/key-store'

const NOW = 1_700_000_000_000
const base = { kind: 'permission' as const, taskId: 'a1b2c3d4', requestId: 'perm-demo-1', body: '整理作品集:npm i sharp', now: NOW }

describe('sim-push', () => {
  it('devToken:合成的开发令牌,过 isDevPushToken,不是真设备令牌的形状', () => {
    expect(isDevPushToken(devToken('sim-push'))).toBe(true)
    expect(devToken('a')).not.toBe(devToken('b'))
  })
  it('ok:形状与中继发给 APNs 的一致(占位 alert + mutable-content + wcc),用开发令牌的推送密钥能解开', () => {
    const tok = devToken('sim-push')
    const p = buildSimPush({ ...base, token: tok, mode: 'ok' })
    expect(p.aps).toEqual({ alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' })
    const plain = PushPlaintext.parse(openPush(derivePushKey(tok), p.wcc, NOW))
    expect(plain).toMatchObject({ kind: 'permission', taskId: 'a1b2c3d4', requestId: 'perm-demo-1' })
    expect(readFileSync(new URL('../../relay/src/push-apns.ts', import.meta.url), 'utf8')).toContain("'mutable-content': 1")
  })
  it('stale / tamper / wrong-key 各自解不开', () => {
    const tok = devToken('sim-push')
    const key = derivePushKey(tok)
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'stale' }).wcc, NOW)).toThrow('stale')
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'tamper' }).wcc, NOW)).toThrow()
    expect(() => openPush(key, buildSimPush({ ...base, token: tok, mode: 'wrong-key' }).wcc, NOW)).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd apps/app && bun run test 2>&1 | tail -5; cd ../..`
Expected: FAIL(`./sim-push-lib` 不存在)。

- [ ] **Step 3: 实现**

`apps/app/scripts/sim-push-lib.ts`:

```ts
import { createHash } from 'node:crypto'
import { b64uDecode, b64uEncode, derivePushKey, PushPlaintext, sealPush, type PushKindT, type SealedPush } from '@wechat-cc/protocol'
import { RELAY_PLACEHOLDER_BODY } from '../src/push/banner'

/** 合成的开发令牌:dev + sha256(seed) 前 48 位 hex。不是任何真设备的令牌(真令牌是 d + 48 位 hex),可以打印。 */
export function devToken(seed: string): string {
  return 'dev' + createHash('sha256').update(seed).digest('hex').slice(0, 48)
}

export type SimMode = 'ok' | 'stale' | 'tamper' | 'wrong-key'

/** 与 apps/relay/src/push-apns.ts 发给 APNs 的载荷同形:占位 alert + mutable-content + wcc 密文。 */
export function buildSimPush(o: { token: string; mode: SimMode; kind: PushKindT; taskId?: string; requestId?: string; body: string; now: number }): {
  aps: { alert: { title: string; body: string }; 'mutable-content': 1; sound: 'default' }
  wcc: SealedPush
} {
  const ts = o.mode === 'stale' ? o.now - 61 * 60_000 : o.now
  const payload = PushPlaintext.parse({ ts, kind: o.kind, title: 'CC', body: o.body, ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.requestId ? { requestId: o.requestId } : {}) })
  const key = derivePushKey(o.mode === 'wrong-key' ? `${o.token}x` : o.token)
  let wcc = sealPush(key, payload)
  if (o.mode === 'tamper') {
    const b = b64uDecode(wcc.ct)
    b[0] = b[0]! ^ 0x01
    wcc = { ...wcc, ct: b64uEncode(b) }
  }
  return { aps: { alert: { title: 'CC', body: RELAY_PLACEHOLDER_BODY }, 'mutable-content': 1, sound: 'default' }, wcc }
}
```

`apps/app/scripts/sim-push.ts`:

```ts
#!/usr/bin/env bun
/**
 * 模拟器上验证 iOS 通知扩展(计划 4 Task 11)。不碰真 daemon、不用真设备令牌。
 *   1) app(开发构建)已在模拟器里开着:bun apps/app/scripts/sim-push.ts --print-link | xargs xcrun simctl openurl <udid>
 *      ⇒ app 显示 dev-push-key-ok(共享钥匙串里存了开发令牌推出的推送密钥)
 *   2) 把 app 切到后台,再:bun apps/app/scripts/sim-push.ts --udid <udid> [--mode ok|stale|tamper|wrong-key] [--repeat]
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PushKind } from '@wechat-cc/protocol'
import { buildSimPush, devToken, type SimMode } from './sim-push-lib'

const { values: v } = parseArgs({
  options: {
    udid: { type: 'string', default: 'booted' },
    seed: { type: 'string', default: 'sim-push' },
    kind: { type: 'string', default: 'permission' },
    task: { type: 'string', default: 'a1b2c3d4' },
    request: { type: 'string', default: 'perm-demo-1' },
    body: { type: 'string', default: '整理作品集:npm i sharp' },
    mode: { type: 'string', default: 'ok' },
    repeat: { type: 'boolean', default: false },
    'print-link': { type: 'boolean', default: false },
  },
})
const token = devToken(v.seed!)
if (v['print-link']) { console.log(`tendhearth://dev-push-key?token=${token}`); process.exit(0) }
const mode = v.mode as SimMode
if (!['ok', 'stale', 'tamper', 'wrong-key'].includes(mode)) { console.error(`unknown --mode ${mode}`); process.exit(2) }
const payload = buildSimPush({ token, mode, kind: PushKind.parse(v.kind), taskId: v.task || undefined, requestId: v.request || undefined, body: v.body!, now: Date.now() })
const file = join(tmpdir(), `th-sim-push-${process.pid}.apns`)
writeFileSync(file, JSON.stringify(payload))
let code = 0
for (let i = 0; i < (v.repeat ? 2 : 1); i++) {
  const r = spawnSync('xcrun', ['simctl', 'push', v.udid!, 'com.tendhearth.app', file], { stdio: 'inherit' })
  code = r.status ?? 1
}
rmSync(file, { force: true })
process.exit(code)
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?; cd ../..`
Expected: `app=0`。

- [ ] **Step 5: 在模拟器上走一遍(按 Task 1 的结论选分支)**

前置:`th-push` 上装着 Task 9 / 10 的 development build,`bunx expo start --dev-client` 在跑;app 已打开、停在欢迎页或此刻。先点「先看看」进演示(点通知后要进的是演示里的 `a1b2c3d4`)。

```bash
UDID=$(cat /tmp/th-push-udid)
maestro --device "$UDID" test apps/app/.maestro/subflows/_start.yaml     # 干净启动到欢迎页
# 手动或 Maestro 点「先看看」
bun apps/app/scripts/sim-push.ts --print-link | xargs xcrun simctl openurl "$UDID"
# app 里出现 dev-push-key-ok;若首次打开链接时系统问「在 Tendhearth 中打开?」,点 Open。
xcrun simctl launch "$UDID" com.apple.Preferences                         # app 进后台
```

**分支 A:`NSE_UNDER_SIMCTL=yes`**(扩展会跑)—— 逐条执行,每条之后 `xcrun simctl io "$UDID" screenshot /tmp/th-push-<n>.png` 并用 Read 看:

| # | 命令 | 期望 |
|---|---|---|
| 1 | `bun apps/app/scripts/sim-push.ts --udid "$UDID"` | 横幅标题「需要你批准 / Needs your approval」(跟模拟器系统语言),正文「整理作品集:npm i sharp」 |
| 2 | `… --mode stale` | 中性占位「CC 有新动态 / CC has news」 |
| 3 | `… --mode tamper` | 中性占位 |
| 4 | `… --mode wrong-key` | 中性占位 |
| 5 | `… --repeat` | 第二条不响(passive);通知中心里同一件事只留最新一条(APNs 本地模拟不一定按 collapse-id 合并,记下观察) |
| 6 | 点第 1 条通知(通知中心里点) | app 回前台 → 中转页 → 批准页 `approval-title`,原始命令可见 |
| 7 | app 在前台时 `… --udid "$UDID"` | 不弹系统横幅;app 顶部出现 `push-banner`;点它 ⇒ 批准页 |
| 8 | 杀掉 app(`xcrun simctl terminate "$UDID" com.tendhearth.app`)后 `…`,再点通知 | 冷启动直接到批准页 |

再把模拟器系统语言切成中文 / 英文各验一次第 1 条的标题(设置 → 通用 → 语言与地区,或 `xcrun simctl spawn "$UDID" defaults write -g AppleLanguages '("zh-Hans")'` 后重启模拟器)。

**分支 B:`NSE_UNDER_SIMCTL=no`**(扩展不跑)—— 只验 app 端:
- 第 1 条:横幅是中继原样的「CC / CC 有新动态」(扩展没跑);**点它** ⇒ 中转页 ⇒ 批准页(app 用兜底密钥在 app 里解开了 `wcc`,Task 6 的兜底路径)。
- 第 7 条同上(前台横幅由 `bannerFrom` 显示中性占位;点开同样进批准页)。
- 扩展的解密、本地化、去重只由 `swift test`(Task 3)覆盖,真机验收补上(文末)。

结果写进 `apps/app/README.md` 推送一节:

```markdown
### 在模拟器上验通知(scripts/sim-push.ts)

1. 开发构建开着、进了演示:`bun apps/app/scripts/sim-push.ts --print-link | xargs xcrun simctl openurl <udid>` ⇒ 页面出现 `dev-push-key-ok`
2. app 进后台:`bun apps/app/scripts/sim-push.ts --udid <udid> [--mode ok|stale|tamper|wrong-key] [--repeat]`
3. 2026-09-30 的结果:<表格里每一条的实际观察;分支 B 时写明哪些只能真机验>

开发令牌是合成的(`dev` + 48 位 hex),不是任何真设备的令牌;`/dev-push-key` 在发布构建里不生效。
```

- [ ] **Step 6: Commit**

```bash
git add apps/app/scripts apps/app/README.md
git commit -m "app 推送:模拟器端到端 —— 合成开发令牌 + 真密文经 simctl push 验扩展与点击路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: EAS 配置、CI 原生作业、文档、全量回路、PR

**Files:**
- Create: `apps/app/eas.json`
- Modify: `.github/workflows/ci.yml`、`apps/app/README.md`、`docs/roadmap.md`、`docs/INDEX.md`、`docs/maintainer/relay.md`

- [ ] **Step 1: eas.json(只加,不运行)**

```json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": { "TENDHEARTH_APNS_ENV": "development" }
    },
    "preview": {
      "distribution": "internal",
      "env": { "TENDHEARTH_APNS_ENV": "production" }
    },
    "production": {
      "autoIncrement": true,
      "env": { "TENDHEARTH_APNS_ENV": "production" }
    }
  },
  "submit": { "production": {} }
}
```

(`GOOGLE_SERVICES_JSON` 由主人在 EAS 项目里建成**文件型**环境变量,不写进这里;`extra.eas.projectId` 由主人 `eas init` 生成后再提交。)

- [ ] **Step 2: CI 原生作业**

`.github/workflows/ci.yml` 在 `app:` 作业之后加:

```yaml
  # 推送解密的原生两端跑协议包的同一份向量(spec §9.3)。macOS runner 自带 Swift / Xcode;Gradle 版本与本机一致。
  app-native:
    name: app · native push vectors
    needs: changes
    if: needs.changes.outputs.app == 'true'
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - name: Swift (CryptoKit)
        working-directory: apps/app/native/ios-notify
        run: swift test
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '9.1.0'
      - name: Kotlin (JVM)
        working-directory: apps/app/native/android-push
        run: gradle --no-daemon test
```

- [ ] **Step 3: 文档**

`apps/app/README.md`:
- 开头一段补一句:「配对后收系统通知:iOS 通知服务扩展与安卓消息服务在本机解密(`native/`),由 `plugins/` 在 prebuild 时接进构建。」
- 「推送(原生通知)」一节补全(Task 1 / 11 已写的两小节保留):
  - **规矩**:通知从不执行操作(category 无动作);扩展 / 服务只拿推送密钥记录,拿不到设备令牌(主 app 自己的钥匙串组排第一);令牌、密钥、token 不进日志;解不开 ⇒ 中性占位;标题按 kind 在原生端本地化(`native/push-strings.json`,改文案两种语言一起改);改钥匙串键名 / service / 格式 ⇒ `key-store.ts`、`ExtensionStores.swift`、`SecureStoreReader.kt` 一起改(`plugins/native-guards.test.ts` 钉住)。
  - **怎么跑**:`cd native/ios-notify && swift test`;`native/android-push/test.sh`(第一次联网,之后 `--offline`);`bunx expo prebuild --platform ios --clean` 之后 `pod install`,再 `bunx expo run:ios`。
  - **构建环境变量**:`TENDHEARTH_APNS_ENV`、`APPLE_TEAM_ID`、`GOOGLE_SERVICES_JSON`(见 `app.config.js` 头注释)。
- 目录表加 `native/`、`plugins/`、`locales/`、`scripts/`、`src/push/`。
- 「被根测试 import 的文件」清单加 `src/push/{key-store,target,route,register}.ts`。

`docs/roadmap.md` 子项目 3 加一行:「原生通知完成(推送登记、iOS 通知服务扩展、安卓消息服务、点通知路由;Swift / Kotlin 跑协议包向量;模拟器 simctl 验证见 apps/app/README;真投递待主人 APNs 密钥 / Firebase / 中继上线);下一份计划 = 补齐页面」。

`docs/INDEX.md` 登记本计划。

`docs/maintainer/relay.md` 第 8 节(上线前后必读)末尾加一条:「手机 app 的推送需要:中继 v2 上线且 daemon 设了 `relay_v2_url`(否则 app 设置页显示『电脑还没用上 Tendhearth 中继』)、Worker 的 APNs / FCM secrets(第 4 节)。开发构建登记的是 `apns_sandbox`,TestFlight / 商店是 `apns`。」

- [ ] **Step 4: 全量回路**

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..
(cd apps/app/native/ios-notify && swift test > /tmp/app-push-swift.log 2>&1); echo swift=$?
apps/app/native/android-push/test.sh --offline > /tmp/app-push-kotlin.log 2>&1; echo kotlin=$?
bun run test > /tmp/app-push-final.log 2>&1; echo root=$?
npm run test:node > /tmp/app-push-final-node.log 2>&1; echo node=$?
bun run typecheck; echo tc=$?
bun run depcheck; echo dep=$?
git status --short   # 不应出现 ios/、android/、google-services.json、.superpowers/、native 构建目录
```
Expected: 全部 `0`。任何一条非 0:看日志尾部定位,修掉再跑整组。

- [ ] **Step 5: Commit、推送、PR**

```bash
git add apps/app/eas.json .github/workflows/ci.yml apps/app/README.md docs/roadmap.md docs/INDEX.md docs/maintainer/relay.md
git commit -m "app 推送:EAS 构建配置、CI 原生向量作业、文档

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin app-push
```

开 PR 到 `dev`(标题「手机 app 子项目 3 · 原生通知」;正文列 Task、计划裁决、本机验证结果(Task 11 表格)、主人要做的清单;末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`)。等 CI:`app · expo`、`app · native push vectors`、根测试作业全绿(`wechat-cc ci triage --wait --rerun`,用法见 `docs/maintainer/ci-and-flakes.md`)。模拟器 `th-push` 用完删掉:`xcrun simctl delete "$(cat /tmp/th-push-udid)"`。

---

## 计划裁决

1. **扩展 / 消息服务只拿推送密钥,不拿设备令牌**(spec §4 写的是「令牌与派生出的推送密钥存 expo-secure-store,access group 与通知扩展共享」)。设备令牌能以这台手机的身份操作电脑;扩展只需要解密。所以 app 推出密钥后单独存一条 `{v,key,lang}` 记录进共享组,配对记录留在私有组;主 app 的 `keychain-access-groups` 把自己的组排第一,保证不带 accessGroup 的写入(配对记录)不会落进共享组。
2. **通知标题在原生端按 `kind` 本地化,不改 daemon**。daemon(`phone-notifier.ts`)写死了中文标题,测试推送的正文也是中文;spec §1 要求中英跟随系统。原生端拿到 `kind` 就能选标题,正文是用户自己的数据(任务名、请求摘要)原样显示。daemon 零改动。
3. **iOS 的重复推送不能丢,只能静音**(spec §5.5「去重」)。通知服务扩展必须交出内容;真正丢弃要 Apple 特批的 `com.apple.developer.usernotifications.filtering` 权限。所以重复的那条改成 `interruptionLevel = .passive`、不响;中继的 `apns-collapse-id`(= taskId)再让同一件事只留最新一条。安卓的消息服务可以直接不发,就不发。
4. **安卓 Kotlin 直接读 expo-secure-store 的存储格式**,不另写本地 Expo 模块。两条路本机都编不了(没有安卓 SDK),读格式只要 ~30 行、不加构建管线;格式由 `plugins/native-guards.test.ts` 对着 `node_modules` 里的源码钉住,升级 expo-secure-store 时先红。
5. **我们的 FirebaseMessagingService 取代 expo-notifications 自带的**(manifest 里 `tools:node="remove"`)。同一个 `MESSAGING_EVENT` 只能有一个服务收;代价是安卓上 JS 的 token 刷新监听不再触发 —— 由「每次上线 / 回前台重查 token,变了就重登,同一 token 每 24 小时也重登」补上。
6. **安卓前台不显示 app 内横幅**:Kotlin 服务总是发系统通知。daemon 本来就不给「前台且订阅在线」的手机推送(子项目 2 规则),这种情况很少;iOS 前台用 app 自己的横幅(spec §7)。
7. **iOS 的通知权限没有用途说明字符串**(任务书写的是 camera + notifications 的权限文案)。iOS 通知授权框的文字由系统给,Info.plist 里没有对应的键;`locales/` 只放相机说明与显示名,en 与 zh-Hans 同时加。
8. **不需要 App Group**:去重记录只有扩展读写,放扩展自己容器的 UserDefaults;app 与扩展之间只共享一条钥匙串。
9. **点通知统一走 `/push-open` 中转页**:iOS 由响应监听转过去,安卓由 Kotlin 的深链直达,同一段校验与「先拉详情」逻辑。事情不在 ⇒ 中转页说明;请求已处理 ⇒ 批准页自己的「已处理」(计划 2 / 3 的规则)。深链谁都能发,所以参数逐个校验,中转页从不提交任何东西。
10. **APNs 环境由构建环境决定**:`TENDHEARTH_APNS_ENV`(eas.json 的 development / preview / production 各自设好)同时决定 `aps-environment` 与登记的平台(`apns_sandbox` / `apns`)。TestFlight 与内部分发用的是生产 APNs。
11. **扩展没解开时 app 兜底解密再路由**(spec §3 只要求「点开后同步」)。app 手里本来就有设备令牌;兜底解密让「锁屏后首次解锁前到的推送」点开也能直接进批准页。时间用通知送达时刻,否则超过 1 小时才点就解不开。
12. **daemon 还在老中继(没设 `relay_v2_url`)时登记返回 `push_not_wired`**:app 映射成 `unavailable`,设置页如实说「电脑还没用上 Tendhearth 中继」,推送密钥照样先存好;不当错误、不重试风暴(只在每次上线时再试一次)。
13. **模拟器验证用合成开发令牌 + `/dev-push-key`**,不把模拟器配对到主人的真 daemon(那会改真实状态目录里的设备表)。这条路由在发布构建里不生效(`__DEV__` 为 false 直接回此刻),开发令牌的形状(`dev…`)与真设备令牌(`d…`)刻意不同。

## 主人要做的

- **Apple**:在 Apple Developer 里给 `com.tendhearth.app` 开 Push Notifications 能力;新建 App ID `com.tendhearth.app.notify`(EAS 用 `extra.eas.build.experimental.ios.appExtensions` 自动建也行);建 APNs 认证密钥(.p8)并按 `docs/maintainer/relay.md` 第 4 节设进 Worker(`APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID=9Y6JAPDP7A` / `APNS_TOPIC=com.tendhearth.app`);App Store Connect 建 Tendhearth 的 app 记录(API 建不了)。
- **Firebase**:建项目、加安卓应用 `com.tendhearth.app`,下载 `google-services.json` —— 本地放 `apps/app/google-services.json`(已 gitignore),EAS 上建文件型环境变量 `GOOGLE_SERVICES_JSON`;服务账号 JSON 设进 Worker 的 `FCM_SERVICE_ACCOUNT`。
- **中继上线**:按 `docs/maintainer/relay.md` 第 8 节上 v2,daemon 的 `agent-config.json` 设 `relay_v2_url`,重启 daemon。
- **EAS**:`cd apps/app && eas init`(生成 projectId 后提交)、`eas build --profile development --platform ios`(真机开发构建);TestFlight 用 `--profile production` + `eas submit`;Google Play 开发者账号($25)后安卓 `--profile production`。
- **安卓设备**:一台安卓手机或装安卓模拟器(本机目前没有 adb / 安卓 SDK:Kotlin 服务的编译与运行都只能在 EAS 构建 + 真机上验)。
- **真机验收**(spec §9.5):配对 → 通知权限框 → 设置里「已开启」→「发一条测试通知」收到 → 电脑上交办一件要批准的事 → 手机收到「需要你批准」(前台:app 内横幅;后台;进程被杀)三种都点开进批准页 → 允许 → 电脑继续 → 做完收到「做完了」;锁屏状态也收一次;在电脑上撤销这台手机后再触发推送 ⇒ 只显示「CC 有新动态」;iOS 与安卓各一遍。
- **正式图标**:Codex 出稿后替换 `assets/images/*`(含单色图与通知小图标)。

## Next plan(计划 5:补齐页面)

Codex 待补稿的页面(spec §2):首次打开的完整配对 / 演示入口、扫码与配对结果、设备管理与撤销、空状态、多请求选择页的正式样式、各类通知长相的设计验收、电脑离线 / 设备被撤销两种提示的正式样式、设置页(语言、通知、关于、隐私)的正式样式;落盘的查询缓存(计划 3 裁决 6);`lan=` 直连若立项另议。之后是计划 6「真机与发布」(TestFlight、Play 内部测试、演示模式审核说明、商店截图)。
