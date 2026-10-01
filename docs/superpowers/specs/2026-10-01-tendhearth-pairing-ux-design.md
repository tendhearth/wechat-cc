# Tendhearth 配对体验(桌面 + 手机 + 中继)· spec(plan 7a)

日期:2026-10-01。状态:设计稿。基线 origin/dev c2f35af4(#163 设计统一)。增补 `2026-09-30-tendhearth-app-v1-design.md` §6(配对)与 `2026-09-27-device-token-registry-design.md`(链接令牌 / 设备令牌)。plan 7 拆成两份:**7a = 配对(本 spec)**,7b = 在手机上接着电脑上的 Claude Code / Codex 会话(另起 spec / 计划)。

依据(**有约束力**):
- 主人 2026-10-01 的决定(§1)
- 控制者裁决 1–8(§2,原样采纳)
- 设计原则 `~/Documents/tendhearth/cc-screens-2026-09-30/CC-设计原则.md`(下称「原则」):只留 CC + 功能、全衬线、一个强调色、页面不变色(无深色模式)、CC 明暗 = 真实在不在身边

## 0. 白话

在电脑上点「连接手机」,屏幕上出一个码;手机用系统相机一扫,Tendhearth app 自己打开、问一句「连接你的电脑?」,点「连接」就好。一个码只能用一次、10 分钟内有效。电脑还没开通手机连接服务时,直说「还没开通」,不给一个扫了也连不上的码。重装 app 或换新手机:iOS 上配对多半跟着备份回来,app 一启动先跟电脑核对,对不上就老老实实回欢迎页,让你在电脑上再点一次「连接手机」;安卓这一版不备份,重扫一次。重新配对时,同一台手机原来占的那个设备位顺手退掉。

## 1. 主人的决定

1. 用二维码配对,没有账号(Paseo / Orca 也是这样)。
2. 桌面引导(首次安装)直接给出这个码。
3. 「手机扫码改设置」改名「连接手机」。
4. iOS 通用链接(Universal Links)/ 安卓 App Links:系统相机扫码直接打开 app。
5. 重装 / 换新手机后恢复配对(iCloud 钥匙串 / 安卓备份)。
6. 上架前修掉「10 分钟内同一个码能重复配对」。
7. 设计按原则。

## 2. 裁决(采纳)与本 spec 补的决定

控制者裁决 1–8 原样采纳,落点见 §3–§9。下面是裁决没覆盖、本 spec 补上的决定(实施以此为准,交主人过目):

- **D1 只有链接令牌能换设备令牌**:`POST /set/api/pair` 的调用者不是链接令牌(`origin !== 'link'`)⇒ `403 { ok: false, error: 'link_only' }`。否则一枚泄露的设备令牌能不停地多铸长期令牌,撤销后还留后门;「一次性」也就名存实亡。今天没有任何调用方用设备令牌配对。
- **D2 第二次用同一个码配对的回包**:daemon 侧是 `401 { error: 'unauthorized' }`(与其它失效令牌同一形状,不新增错误码);app 早已把链接阶段的 401 / `auth_failed` 映射成 `PairError('expired')`,文案改成「用过或过期」。裁决 1 里说的「401 `expired`」就是这条链路。
- **D3 桌面用一个新的 admin 路由,不复用 trusted 的 `GET /v1/settings/link`**:`POST /v1/phone/link`(必要时打开远程隧道并重启 daemon、只在 v2 中继就绪时出码)+ `GET /v1/phone/devices`(轮询「已连上」)。走原生宿主的 operator 凭据,四处白名单照 plan 6 `/v1/connections` 的样子登记。`GET /v1/settings/link` 留着(`selftest phone` 用),但在 7a 升到 **admin**(§11.7):它铸的是 admin 档链接令牌,trusted 的普通聊天会话不能够着;`selftest phone` 改用 operator 凭据,operator `routeAllow` 加上它;微信 `/set` 走进程内 `settingsPanelLink()`(`isAdmin` 门),不经 HTTP,不受影响。
- **D4 引导页也自动打开远程隧道**:引导页的码用同一个 `POST /v1/phone/link { enable_remote: true }`。全新安装的 `remote_tunnel` 默认关,所以第一次会让刚启动的 daemon 重启一下(约 10 秒,显示「正在打开手机连接」);中继没开通时整块不出现(裁决 3)。到引导页最后一步就会打开手机连接,CC 因此重启一次,这一步会明说(「正在准备连接手机的二维码，CC 会重启一下……」)。主人要的是「引导页直接给码」,多一个「打开」按钮就不是直接给了。
- **D5 旧设备位用「旧令牌自己解除配对」退掉**(裁决 7 的机制选择):新配对存进钥匙串之后,app 用**旧令牌**连旧电脑发 `unpair_self`。凭据证明就是那次加密握手本身(只有持有旧令牌的人握得上),令牌从不进请求正文,daemon 不加新接口;旧令牌已失效 ⇒ 握手失败、静默跳过。比「配对请求里带上旧 id + 旧令牌」好在顺序:新令牌确认可用、已存好之后才退旧的,新配对失败时旧的还在。换到另一台电脑时同样退掉旧电脑上的那个位(旧令牌本地已被覆盖,留着只是死位)。
- **D6 桌面新文案也写 zh + en**:桌面今天只有中文界面,新字符串集中在 `apps/desktop/src/modules/phone-connect-copy.js` 的 `{ zh, en }` 两份(键一致,单测钉住),界面渲染 `zh`;等桌面有语言切换时直接用。
- **D7 自定义 scheme 的配对链接只在开发构建可达**:`tendhearth://relay.tendhearth.com/pset/#…` 只给模拟器 / Maestro 走同一条 JS 链路用;发布构建只认 `https://relay.tendhearth.com/pset/…`(以及开发构建的 staging 主机)。任何入口都只到确认卡。
- **D8 启动核验只在「这次启动还没连上过」时清配对**:首次握手前就被拒(`revoked`)或 `/set/api/state` 里「这台」的 id 对不上记录 ⇒ 当作恢复回来的旧配对,清掉、回欢迎页并说明;已经连上过之后才被撤销 ⇒ 维持现状(最后同步的内容 + 「重新配对」)。电脑不在线不清(分不清是关机还是换了身份)。

## 3. 单次配对(裁决 1)

现状:链接令牌(`t` + 16 字节 hex,admin 档,`routeAllow = PHONE_ROUTES`,10 分钟,`sessionKey: 'link'`,同一时刻只一枚)同时是配对凭据,`POST /set/api/pair` 从不消耗它 ⇒ 一个码 10 分钟内能配 N 台。

改成:
- `settings-panel.ts` 的 `/set/api/pair`:先查 D1;`devices.pair()` 成功后**立刻** `tokens.invalidateSession('link')`;`device_limit` 时不消耗(码还能在腾出位子后用)。
- 隧道:`tunnel-client.ts` 的 `activeLinkToken()` 读的是同一个注册表 ⇒ 消耗后,新握手里不再有这枚候选令牌 ⇒ 手机拿旧码连只会 `auth_failed`。v2 流在处理请求**之前**核对令牌,配对那条回包照常发出(`tunnel-v2-stream.ts` `onReq` 先 `checkToken()` 再 `handleRequest`)。
- 重发码仍然作废旧码(`issueToken` 先 `invalidateSession('link')`,不变)。
- **网页(pset 壳 + `/m`)**:配对按钮成功后存设备令牌、`T` 换成设备令牌(已有);新增两处诚实性修补 ——
  1. `transport.js` 加 `resetTunnel()`:配对后关掉绑着旧短令牌的隧道,下一次 `api()` 用设备令牌重新握手(否则同一条隧道上的后续请求被 daemon 注入旧短令牌 ⇒ 401)。`nav.js` 配对成功后调用。
  2. `transport.js` 加 `onUnauthorized(sentAs)`:401 只在「发请求时的令牌 === 现在的 `T`」时才清本机设备令牌并回 `/m`;配对刚换令牌时在飞的旧请求回 401 不算(否则刚存的设备令牌被误删,手机被踢回「回微信要新链接」)。`home.js` 两处 401 处理改用它。
  3. pset 壳的失效提示改为「这个链接已经用过或过期了,回微信跟 CC 再要一个」。
- 受影响的现有测试:凡是「配对之后还拿同一个链接令牌请求」的,改成配对后 `issueToken()` 换新码(已知:`settings-panel.test.ts` 推送路由的 `up()`、`phone-api-schema.test.ts` 两处、`settings-panel-workbench.test.ts` 两处)。

## 4. 桌面「连接手机」与远程隧道(裁决 2、4)

### 4.1 daemon:`POST /v1/phone/link`、`GET /v1/phone/devices`

纯函数 `phoneLinkState`(新文件 `src/daemon/phone-link.ts`)按顺序判:

| 条件 | state |
|---|---|
| 没有主人(没绑微信) | `no_owner` |
| `agent-config.json` 的 `relay_v2_url` 空 | `relay_not_configured` |
| `remote_tunnel` 不是 `true` | `remote_off` |
| 这次启动没有远程隧道(刚打开、还没重启) | `starting` |
| 这次启动的隧道 id 不是 v2 的 `r…`(身份文件坏了 / 配了 v2 但还没重启) | `relay_unavailable` |
| 其余 | `ready` |

`settingsPanel.phoneLink({ enableRemote })`:
- `remote_off` 且 `enableRemote` 且接了 `deps.remote` ⇒ `setEnabled(true)` + 审计一行 + `requestRestart()`,回 `{ ok: false, state: 'starting' }`。**不碰 `relay_v2_url`**(主人事项)。
- `ready` ⇒ 铸链接令牌,回 `{ ok: true, state: 'ready', url, expires_at }`;`url` 与 `linkUrl()` 同形:`https://<中继主机>/pset/#id=<r…>&t=<令牌>&p=%2Fset[&lan=<ip:port>]`(有局域网地址才带 `lan=`)。URL 由同一个 `psetUrl()` 拼(`linkUrl()` 也改用它)。
- 其余 ⇒ `{ ok: false, state }`,不铸令牌。

路由(新文件 `src/daemon/internal-api/routes-phone.ts`,两条都是 **admin**):
- `POST /v1/phone/link` 正文 `{ enable_remote?: boolean }`(别的类型 ⇒ 400 `invalid_request`);没接 ⇒ 503 `phone_not_wired`;抛 ⇒ 503 `unavailable`。
- `GET /v1/phone/devices` ⇒ `{ ok: true, devices: DeviceRow[] }`(`id / created_at / last_seen_at / label?`,不含令牌)。

接线:`InternalApiDeps.phoneConnect`(`PhoneConnectDep`)、`setPhoneConnect`、`lifecycle.ts`、`wiring/index.ts`、`pipeline-deps.ts`(`relayV2Configured` 读 agent-config,`phoneConnect` 包 `settingsPanel.phoneLink / phoneDevices`)、`main.ts`。远程开关的真实读写抽在 `src/daemon/remote-toggle.ts`(`makeRemoteToggle` 只翻 `remote_tunnel`,`relayV2Configured` 只读),测试走真实写盘那一路钉住 `relay_v2_url` 原样。

### 4.2 桌面可达:四处白名单(plan 6 模式)

`route-tiers.ts`(admin)→ `token-registry.ts` operator `routeAllow` → `apps/desktop/workbench-proxy.ts` `ROUTES`(dev 代理;`/v1/phone/*` 在 mock 模式交给 test-shim)→ `apps/desktop/src-tauri/src/lib.rs` `workbench_request_allowed`(+ Rust 单测的放行 / 拒绝两张表)。`scripts/route-registry.guard.test.ts` 钉包含关系。渲染进程永远拿不到 operator 令牌(`invokeWorkbenchApi`)。

### 4.3 桌面界面

- 设置抽屉的按钮 `#open-phone-settings`(id 不改):文字「连接手机」,去掉 `↗`;`title` 改为 §9 的 `buttonTitle`。画室空状态文案改为指向「连接手机」(见 §9)。全仓库面向用户处不再出现「手机扫码改设置」(守卫断言)。
- 弹层 `#phone-settings-modal`(id 不改)一张卡、无阴影:标题「连接手机」+ 正文区 + 底部按钮。正文按 `POST /v1/phone/link` 的结果:
  - `ready` ⇒ 二维码 + 「用手机相机扫一下。10 分钟内有效,只能用一次。」+ 小字「没装 Tendhearth 的手机会打开网页版设置。」+「复制链接」(app 配对页的粘贴入口要它)。
  - `starting` ⇒ 「正在打开手机连接,CC 会重启一下。」每 2 秒重试,45 秒没好 ⇒ 「手机连接还没打开。稍后再点一次「连接手机」。」
  - `relay_not_configured` ⇒ 「手机连接服务还没开通」/「开通之后,这里会出现二维码。」(不出码)
  - `relay_unavailable` / `remote_off` / `no_owner` ⇒ 各自一句(§9)。
  - 出码后每 2 秒 `GET /v1/phone/devices`:出现新 id(与出码前的快照比)⇒ 「已连上 <label>」(label 还没写好就再等两轮,仍没有 ⇒ 「已连上手机」),按钮变「完成」;到 `expires_at` ⇒ 「这个码过期了。」+「换一个」。
  - 关闭:按钮 / `Esc` / 点遮罩;关闭即停轮询。label 是用户内容,一律 `textContent`。
- 逻辑在 `apps/desktop/src/modules/phone-connect.js`(纯函数 `linkView / newDevice / pairedLine` + 可注入时钟的 `makePhoneLinkFlow` + 两个挂载器),`main.js` 只接线。

## 5. 引导页直接给码(裁决 3)

- 放在 `#screen-service` 最后、`#enter-dashboard` 之前的 `#onboard-phone`(不加第五步,`STEP_ORDER` / 「step n of 4」不变)。
- 进入这一步且 daemon 活着 ⇒ 跑 §4.3 同一个流程(`enable_remote: true`,D4)。**只有拿到 `ready` 的码才显示码**;`starting` 时整块亮出并说明 CC 会重启一下,拿到码换成码;其余状态整块不出现。
- 文案(§9):标题 `title`、出码 `readyNote`、末行 `later`;连上 ⇒ `paired`。
- 永不挡「进入控制台」;离开这一步(进控制台)即停轮询。已配置好的老用户扫码后直接进控制台(`afterScanTarget`),看不到这一块 —— 他们用设置里的按钮。

## 6. 通用链接 / App Links(裁决 5)

### 6.1 中继 Worker 的两个文件

`apps/relay/src/well-known.ts`(纯函数)+ `index.ts` 分流,两个主机(`relay.tendhearth.com`、`relay-staging.tendhearth.com`)同一份:
- `GET /.well-known/apple-app-site-association` ⇒ `application/json`,不重定向:
  `{ "applinks": { "details": [{ "appIDs": ["9Y6JAPDP7A.com.tendhearth.app"], "components": [{ "/": "/pset" }, { "/": "/pset/*" }] }] } }`
- `GET /.well-known/assetlinks.json` ⇒ 读 Worker secret `ANDROID_CERT_SHA256`(逗号分隔,每个是 32 组冒号分隔的大写 hex;小写会被规范成大写,畸形的丢掉):有 ⇒ 一条 `delegate_permission/common.handle_all_urls`,`package_name: com.tendhearth.app`;没设 / 全畸形 ⇒ `[]`(合法 JSON,验证失败,浏览器兜底)。
- 两个都 `cache-control: public, max-age=300`。签名指纹不在仓库(主人事项 §11)。

### 6.2 app 配置

- iOS:新插件 `apps/app/plugins/with-app-links.js` 用 `withEntitlementsPlist` 写 `com.apple.developer.associated-domains`:发布构建 `applinks:relay.tendhearth.com`;开发构建(`TENDHEARTH_APNS_ENV` 不是 `production`)再加 `applinks:relay-staging.tendhearth.com`。不用 `ios.associatedDomains` 字段(app.config.js 的约定:entitlements 只由插件写)。
- 安卓:`app.config.js` 设 `android.intentFilters`(同一文件导出的 `androidIntentFilters(dev)`):`VIEW` + `BROWSABLE/DEFAULT` + `autoVerify: true`,`https` + 上面的主机,`path: /pset` 与 `pathPrefix: /pset/`。

### 6.3 链接进 app

- `src/net/system-link.ts`(纯):`systemPairLink(url, dev)` 只认 `https://relay.tendhearth.com/pset[/][#…]`(开发构建再认 staging 主机与 `tendhearth://<主机>/pset/#…`,D7),规范成 `https://<主机>/pset/#…`;别的 ⇒ `null`。`setPendingLink / takePendingLink` 是一格的取后即焚暂存 —— **令牌不进路由参数**。
- `push/open.ts` 的 `rewriteSystemPath` 先问 `systemPairLink`:命中 ⇒ 暂存原链接,返回 `/pair?from=link&n=<序号>`(序号让 app 已在配对页时也能重新触发);其余照旧。
- 配对页看到 `from=link` ⇒ `linkIntake([takePendingLink(), systemPairLink(Linking.getLinkingURL())])`:第一个能解析的 ⇒ **确认卡**(主机名 + 「连接」,永不自动配对);都解析不了且像是锚点丢了 ⇒ 「这个链接没带全。请在电脑上点「连接手机」,用相机再扫一次。」(扫码按钮照常在)。
- **锚点探针(计划 Task 1)**:锚点(`#id=…&t=…`)是中继看不到令牌的前提,不能改成查询串。源码证据链(守卫测试钉住,依赖升级先红):iOS 场景委托把 `userActivities` 转给 AppDelegate 订阅者 ⇒ expo-linking 存 `webpageURL`、交给 JS 时用 `absoluteString`;安卓冷启动 `uri.toString()`、热启动 `DeviceEventManagerModule` 同样 `uri.toString()` ⇒ expo-router 在无重定向表时把**原样 URL** 交给 `redirectSystemPath`。真机 / 模拟器验证放在 Task 9 的 Maestro(自定义 scheme)与最后的真机验收(https)。即使真机上锚点丢了,§6.3 的「没带全」分支也让人有路可走(用 app 内扫码)。探针结论写回本节下表:

| 环节 | 结论 | 证据 |
|---|---|---|
| expo-router → `redirectSystemPath` 拿到原样 URL | 保留(源码,expo-router 57.0.24) | `plugins/link-fragment.guard.test.ts` |
| iOS 通用链接 → JS 保留锚点 | 保留(源码:场景委托转发 + `webpageURL.absoluteString`);真机见 Task 12 | 同上 |
| 安卓 App Link → JS 保留锚点 | 保留(源码:`uri.toString()` 冷 / 热两路);真机见 Task 12 | 同上 |
| iOS 模拟器,开发 scheme(`tendhearth://<主机>/pset/#…`)→ 确认卡 | 保留:锚点到达 app,确认卡显示中继主机名(Maestro pair-link PASS,Task 1 + Task 9) | `apps/app` Maestro pair-link |
| iOS 真机 https 通用链接(相机扫码) | 待真机(主人) | 验收清单第 2 项 |
| 安卓真机 App Link | 待真机(主人;需先设 `ANDROID_CERT_SHA256`) | 验收清单第 4 项 |

- 微信内置浏览器不走通用链接 —— 微信里点的 `/set` 链接照旧开网页壳。装了 app 的手机用系统相机扫码一律进 app(网页设置从 app 外打不开,app 自己有设置),可接受。

## 7. 重装 / 换新手机(裁决 6)

- iOS:配对记录在钥匙串,`AFTER_FIRST_UNLOCK`(不是 `…THIS_DEVICE_ONLY`)⇒ 加密备份 / 设备间迁移会带上;卸载重装钥匙串通常也还在。守卫测试钉住 `secure-store.ts` 用的就是 `SecureStore.AFTER_FIRST_UNLOCK`,且不出现 `THIS_DEVICE_ONLY`。真机验证是主人事项。
- iCloud 钥匙串**同步**(`kSecAttrSynchronizable`)不做:要原生模块,而且把一枚活的设备令牌同步到同一 Apple ID 的每台设备是安全决定 —— 交主人。
- 安卓:expo-secure-store 的备份规则排除 `SecureStore`、Keystore 密钥不迁移 ⇒ 7a 不做安卓凭据备份(守卫测试钉住备份规则,免得以后误以为能恢复);以后的路是 Google Block Store。
- **启动核验(D8)**:有配对记录的一次启动里 ——
  - 首次 `online` 之前就 `revoked` ⇒ `onStale`;
  - 首次 `online` 后读一次 `/set/api/state`(`backend.devices()`),「这台」的 id ≠ 记录的 `deviceId` 或没有「这台」⇒ `onStale`;读失败 ⇒ 不下结论;
  - `onStale` = 清钥匙串(配对 + 推送密钥)、内存配对置空、回欢迎页,欢迎页多一行「这台手机和电脑的配对已经失效了。」。
  - 核验完成前状态行是「连接中」(灰点)、CC 是 Dark —— 从不先画「在线」(已有:`INITIAL_CONNECTION.state === 'connecting'`,单测钉住)。
- 欢迎页常驻一行「在电脑上点「连接手机」,用相机扫一下。」;配对页的三步与错误文案同步改成「连接手机」。
- 已知限制(不在 7a):电脑重装 / 换了中继身份 ⇒ 手机记录指向一个永远不在线的 id,app 只会一直显示「不在线」;要在设置里手动「解除配对」再扫。设备间迁移后旧手机与新手机持有同一枚令牌(都能用),主人可在设备列表里撤掉一台(撤掉后两台都失效、各自重扫)。

## 8. 旧设备位(裁决 7,机制见 D5)

- `pairing.ts` 新增 `retirePrevious(prev, next, { connect })`:`prev` 为空或令牌相同 ⇒ `skipped`;否则用 `prev.deviceToken` 连 `prev.relayUrl`,`POST /set/api/apply { op: 'unpair_self' }`,成功 ⇒ `retired`,任何失败 ⇒ `failed`(吞掉,不抛)。连接用完即关。
- 配对页:`pairAndSave` 成功之后 `void retirePrevious(session.pairing, rec, …)`,不等它就回此刻。
- 已知限制(Task 11):重新配对时若旧电脑离线,旧设备位会留着,直到主人在桌面设备列表里手动移除它(期间仍占 20 台上限的名额)。
- 核对码:配对成功后 daemon 回一个简短的核对码(`check_code`,`packages/protocol/src/pair-check.ts`),桌面弹层、引导页和手机确认卡都显示,供主人肉眼核对是同一次配对。
- §11.7 已在 7a 修掉:`GET /v1/settings/link` 升为 admin 档。
- daemon 不改(`unpair_self` 只撤调用者自己、经隧道可用,已有);加一条 daemon 单测钉住「A、B 两台,A 的令牌 `unpair_self` ⇒ 只剩 B」。

## 9. 文案

中文用全角标点(,。?:「」()),引号用「」,嵌套也用「」;英文用弯引号 “”。手机进 `apps/app/src/i18n/{zh-Hans,en}.ts`(键一致);桌面进 `phone-connect-copy.js` 的 `{ zh, en }`(D6)。

| 位置 | 键 | zh | en |
|---|---|---|---|
| 桌面按钮 | `button` | 连接手机 | Connect phone |
| 桌面按钮 title | `buttonTitle` | 用手机扫码连上这台电脑（码 10 分钟内有效，只能用一次） | Scan with your phone to connect it to this computer (each code works once, for 10 minutes) |
| 弹层 / 引导标题 | `title` | 连接手机 | Connect phone |
| 准备中 | `loading` | 正在准备二维码…… | Preparing a code… |
| 出码 | `readyNote` | 用手机相机扫一下。10 分钟内有效，只能用一次。 | Scan it with your phone’s camera. It works once, for 10 minutes. |
| 出码小字 | `readySub` | 没装 Tendhearth 的手机会打开网页版设置。 | Phones without Tendhearth open the web settings instead. |
| 复制 | `copyLink` / `copied` | 复制链接 / 已复制 | Copy link / Copied |
| 打开隧道中 | `starting` | 正在打开手机连接，CC 会重启一下。 | Turning on phone connections. CC will restart for a moment. |
| 打开超时 | `startTimeout` | 手机连接还没打开。稍后再点一次「连接手机」。 | Phone connections aren’t on yet. Try “Connect phone” again in a moment. |
| 中继未开通 | `relayNotConfiguredTitle` / `…Body` | 手机连接服务还没开通 / 开通之后，这里会出现二维码。 | The phone connection service isn’t open yet / Once it’s open, a code will appear here. |
| 中继没起来 | `relayUnavailableTitle` / `…Body` | 手机连接服务这次没启动起来 / 重启一下 CC 再试。 | The phone connection service didn’t start this time / Restart CC and try again. |
| 隧道关着且开不了 | `remoteOffTitle` / `…Body` | 手机连接没打开 / 重启一下 CC 再试。 | Phone connections are off / Restart CC and try again. |
| 没主人 | `noOwnerTitle` | 先用微信扫码登录，再来连接手机。 | Sign in with WeChat first, then connect your phone. |
| 过期 | `expired` / `renew` | 这个码过期了。 / 换一个 | This code has expired. / New code |
| 连上 | `paired` / `pairedNoLabel` / `done` | 已连上 {label} / 已连上手机 / 完成 | Connected: {label} / Phone connected / Done |
| 出错 | `error` | 生成不了二维码：{why} | Couldn’t make a code: {why} |
| 关闭 | `close` | 关闭 | Close |
| 引导末行 | `later` | 之后再连也可以：在设置里点「连接手机」。 | You can do this later: in Settings, choose “Connect phone”. |
| 画室空状态 | (atelier-gallery.js) | 画室尚未开启 / 在设置里点「连接手机」，用手机打开设置，开启「让 CC 自己画画」。首次需下载约 5GB 的画笔。 | — (桌面画室文案只有中文,沿用) |
| 手机欢迎页 | `welcome.howTo` | 在电脑上点「连接手机」，用相机扫一下。 | On your computer, choose “Connect phone” and scan with your camera. |
| 手机欢迎页 | `welcome.stale` | 这台手机和电脑的配对已经失效了。 | This phone is no longer paired with your computer. |
| 配对三步 | `pair.step2` | 选择「连接手机」 | Choose “Connect phone” |
| 配对说明 | `pair.steps` | 在电脑上打开 Tendhearth，点「连接手机」，然后扫描那里显示的码。 | Open Tendhearth on your computer, choose “Connect phone”, then scan the code shown there. |
| 不是配对码 | `pair.errNotALink` | 这不是 Tendhearth 的配对码。请在电脑上点「连接手机」，扫那里显示的码。 | That isn’t a Tendhearth pairing code. On your computer choose “Connect phone” and scan the code there. |
| 老局域网链接 | `pair.errRemoteOff` | 这是只能在同一 Wi-Fi 下用的旧链接。请在电脑上点「连接手机」，扫新出来的码。 | This is an older Wi-Fi-only link. On your computer choose “Connect phone” and scan the new code. |
| 用过 / 过期 | `pair.errExpired` | 这个码已经用过或过期了（每个码只能用一次，10 分钟内有效）。请在电脑上点「连接手机」换一个。 | This code was already used or has expired (each code works once, for 10 minutes). Choose “Connect phone” on your computer for a new one. |
| 锚点丢了 | `pair.errLinkIncomplete` | 这个链接没带全。请在电脑上点「连接手机」，用相机再扫一次。 | This link arrived incomplete. Choose “Connect phone” on your computer and scan again. |
| 网页壳失效 | (pset.src.html) | 这个链接已经用过或过期了，回微信跟 CC 再要一个 | — (网页壳只有中文,沿用) |

## 10. 测试

- daemon(根 `bun run test` + `npm run test:node`):单次配对四态(第一次成功 / 第二次 401 / 重发作废 / `device_limit` 不消耗 / 设备令牌 403 `link_only` / `activeLinkToken()` 消耗后为 null);`phoneLinkState` 全表;`phoneLink` 打开隧道 + 重启、不碰 `relay_v2_url`、只在 ready 铸令牌;两条路由的 tier、400 / 503;`unpair_self` 退旧位。
- 白名单:`route-registry.guard.test.ts`、`token-registry.test.ts` 精确集合、Rust `cargo test`。
- 网页:`apps/mobile/pairing.test.ts`(配对后 `resetTunnel`、`onUnauthorized` 只认当时的令牌、`home.js` 不再直接删令牌)、`pset-shell.test.ts` 新文案。
- 桌面单测(`bun --bun vitest run apps/desktop`):`linkView` 每个 state、`newDevice`、`makePhoneLinkFlow`(starting → ready、超时、过期、label 等两轮、停了不再回调)、文案两份键一致。
- 桌面 e2e(`cd apps/desktop && bun x playwright test`):新 `phone-connect.spec.ts` —— 抽屉按钮叫「连接手机」、出码 → 「已连上 Tendhearth · iPhone」、`relay_not_configured` 不出码、`starting` → 出码、请求带 `enable_remote: true`;引导页 ready 出码 / 未开通不出现、「进入控制台」不被挡。test-shim 加 `/v1/phone/*` 演示路由(这正是调查发现缺的那条 e2e)。
- 中继(`cd apps/relay && bun run test`):AASA 形状与头、assetlinks 未设 ⇒ `[]`、指纹规范化 / 畸形丢弃、入口分流。
- 手机(`cd apps/app && bun run test && bun run typecheck && bun run export:check`):插件(两种构建的 entitlements 与 intentFilters)、锚点守卫、`systemPairLink`、`rewriteSystemPath` 新分支、`linkIntake`、`verifyLaunch` / `watchConnection` 的 stale 分支、`retirePrevious`、钥匙串 / 备份守卫、文案。Maestro `pair-link.yaml`(开发构建、自定义 scheme ⇒ 确认卡出现、没有自动配对)。

## 11. 主人事项(不挡执行)

1. **安卓签名 SHA-256**:Play Console → 应用完整性 → 应用签名密钥(以及上传密钥 / EAS 内部分发用的密钥)的 SHA-256,逗号分隔设进 Worker secret `ANDROID_CERT_SHA256`(staging 与 production 各一次)。
2. **iCloud 钥匙串同步要不要做**(§7)。
3. **真机验 iOS 备份恢复**:加密备份 → 抹掉 / 新机恢复 → 打开 app 应直接连上;再验「电脑上撤掉这台后恢复」⇒ 回欢迎页、说明失效。
4. **安卓 Block Store**:以后的恢复路径,7a 不做。
5. **开通中继**:`relay_v2_url` 仍由主人按 `docs/maintainer/relay.md` §8 设;没设时桌面诚实显示「手机连接服务还没开通」,引导页不出码。
6. Apple 开发者后台:`com.tendhearth.app` 的 Associated Domains 能力(EAS 构建会同步;核对一次)。
7. 顺带发现,**已在 7a 修**(Task 3):`GET /v1/settings/link` 原是 trusted 档,而普通聊天会话也是 trusted —— 一个 trusted 会话能铸出 admin 链接令牌。现在升到 admin;`selftest phone` 改用 operator 令牌(operator `routeAllow` 加上这条,`token-registry.test.ts` 精确集合同步);微信 `/set` 走进程内调用,不受影响。桌面旧按钮在 Task 3 到 Task 5 之间会 403(同一未部署分支,Task 5 换成 `/v1/phone/link`)。
8. 顺带发现,**7a 不修**(Task 2 评审):中继壳模式(`relay/pset.html` 注入 `__CC_SHELL__`)下,`apps/mobile/src/transport.js` 的 `onUnauthorized()` 在本机令牌真失效时 `location.replace("/m")` —— 中继域上没有 `/m`,落到 404。旧代码就是这样(7a 前 `home.js` 内联的同一句),单次配对没让它更糟。以后修:壳模式改走 `ccNav` / 回 `/pset/` 重进,或者原地显示一句「这台手机的连接已失效，回微信跟 CC 再要一个」。

## 12. 不做

- 7b(手机上接着电脑上的会话)、中继上线(`relay_v2_url` 切换)、APNs / Firebase、商店记录。
- iCloud 钥匙串同步、安卓凭据备份。
- 老 VPS 中继 `relay/`(只改它的网页壳文案 `relay/pset.src.html` 与生成物)。
