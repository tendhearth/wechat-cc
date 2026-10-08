# apps/app —— Tendhearth CC 手机 app(Expo 原生)

产品文案统一为 **Tendhearth CC**，对话中称 **CC**，见[命名规范](../../docs/reference/product-naming.md)。现有 `app.json` 的显示名、原生权限说明与截图另作一致性检查；scheme、bundle ID、钥匙串键和推送凭据不随文档改名。

「自己电脑上的个人 AI + 指挥编码 agent」的手机端。这一版有**演示模式**与**真连接**:没配对时是演示后端;扫码配对后换成 `src/backend/live.ts`,经中继连回家里的电脑。配对后收系统通知:iOS 通知服务扩展与安卓消息服务在本机解密(`native/`),由 `plugins/` 在 prebuild 时接进构建。

对话页、事项对话和电脑会话记录的用户与助手正文共用原生 Markdown 阅读组件,首页最近一句只提取可读文字。带格式的用户消息可展开「查看原文」,原始换行与字面语法完整保留且可选择复制;普通文字不增加控件。日志、输入、发送和存储保持原样。只允许打开绝对 HTTP/S 链接;文件与应用链接只显示名称,图片只显示替代文字。长代码与表格在各自区域内横向滚动。中文继续使用已打包的 Noto Serif SC Regular,重点以强调墨色和轻底色呈现。

事项「补充要求」携带首次执行轮次,逐条显示受理、交付、保留、撤回及拒绝回执。原文和首次 requestId/runId 写入本机 SecureStore 分片日志：单片 UTF-8 ≤1800 字节，总计 ≤64 条/512 KiB；只清理已确认且已处理草稿的旧记录，不淘汰未确认补充。正文不可变，回执写入小型状态索引，最后切换版本化提交指针；部分写失败保留上次提交。启动恢复完成前锁住发送，恢复中的 submitting 变为 uncertain，首次发送必须保存成功并复查配对世代。进程结束后仍可恢复；「一起做 → 保留的补充」显示全部未确认项，归档或详情超出中继大小也不隐藏原文。恢复和重连只 GET 单条回执；缺失、旧服务 404/unsupported 不解释为未送达；只有用户显式重试才 POST，沿用原始身份与正文。取回原文不覆盖新草稿，draftHandled 持久化。普通未提交草稿仍只保存在内存中。

日志配对身份使用中继地址、daemon/device 与完整 deviceToken 的 SHA256，不保存明文令牌。换配对、换令牌、演示、解除、撤销、stale 同步隔离内存，先提交 tombstone 后删除分片，迟到读写不能复活。钥匙串拒绝清除时暂停发送并显示错误，不能宣称未实际删除的字节已擦除。

本轮模块测试使用新的存储/控制器实例读取已提交日志，覆盖 20k 中文/emoji/CRLF、缺省 runId、body/index/pointer 部分写失败、恢复零 POST、配对/撤销世代、清除失败 tombstone、64 条和 512 KiB 拒发、已交付禁重试与 draftHandled。真实 SessionProvider 与凭证存储测试验证配对读取暂时失败时保留日志、旧连接迟到撤销不能删除新配对，以及取消配对不能启用无日志的发送。草稿绑定进程归属和修改版本；异步确认之后重新核对当前回执，重启或同文重填都不误清新稿。真实 Compose + LiveBackend 组件测试验证保存失败零 POST、启动锁定、全部未确认可见，以及原始模型错误仅在展开后以纯文本显示。64 条状态更新最多 12 次模拟 SecureStore 写、仅一次 hash，不重写原文；这是调用数量证据，不代表真实 Keychain 调用数量或时延。

2026-10-03 普通 Release 在专用 iOS 27 模拟器完成真实 SecureStore 跨进程验收：正常粘贴链接、核对、连接自有测试设备，在自有事项提交受控补充；实际结束旧进程，再启动新进程，从「一起做 → 保留的补充 → 取回原文」恢复。输入框实际 165 字节 ASCII 原文的全文 SHA256 与 requestId 前后相同，首尾和内部空白保留，held 回执保持；服务端单条回执另行核对。包内无 e2eBuild，使用 Xcode 生成的模拟器 Keychain entitlements；签名修复前后 main.jsbundle SHA 相同。初次无 Keychain 权限的构建显示读取失败并锁住发送，未把读取失败当作无配对清除。

此次 OS 样本包含 Markdown、括号链接和空白，UI 驱动将命令中的换行转为空格，因此只以实际输入框原文作比较；中文、CRLF、多片、容量与故障竞态仍由模块测试覆盖。未独立采集真实网络 POST 次数或 Keychain 调用时延，自动恢复不 POST 的证据来自源码与故障回归；UI 导航和等待耗时不计为 Keychain 性能。物理 iPhone 的持久恢复尚未实测。

- 设计:`docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`,设计稿 `docs/design/tendhearth-app-v1/`
- 计划:`docs/superpowers/plans/2026-09-30-tendhearth-app-skeleton.md`(骨架 + 演示)、`docs/superpowers/plans/2026-09-30-tendhearth-app-live.md`(真连接与配对)、`docs/superpowers/plans/2026-09-30-tendhearth-app-push.md`(原生通知)、`docs/superpowers/plans/2026-10-01-tendhearth-app-chat.md`(跟 CC 说话 + 真历史 + CC 的连接 + 原生会话;spec `docs/superpowers/specs/2026-10-01-tendhearth-app-chat-design.md`)

## 怎么跑

```bash
bun install                      # 仓库根目录,一次
cd apps/app
bunx expo start                  # 开发服务器(连已装的 development build)
bunx expo run:ios                # 首次:生成 ios/ 并在模拟器装 development build
bun run test                     # vitest(纯逻辑与组件交互,node / happy-dom 环境)
bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts   # 仓库根目录:LiveBackend 对着进程内真 daemon 的端到端
bun run typecheck                # tsc --noEmit(本工程自己的 tsconfig)
bun run export:check             # expo export 两个平台,证明能打包
maestro test .maestro/           # 模拟器上跑演示流程(要先有 development build + 开着 expo start)
```

- 加了 `expo-crypto` / `expo-camera`、以及 2026-10-04 的 `expo-audio` / `expo-file-system`(回复里的语音附件)之后要重新 `bunx expo run:ios` 生成 development build,模拟器才有这些原生模块。
- `ios/`、`android/` **不进 git**(`.gitignore` 已列);原生部分以后走 Expo config plugin,保持「预构建可重生」。
- `expo start` / `expo prebuild` 可能改写 `tsconfig.json` / `package.json`,别把这些改动提交。
- 换过 bundle 相关的东西后用 `bunx expo start --clear`,免得模拟器拿到旧 bundle。
- 本工程有自己的 tsconfig 与 vitest;根 `bun run typecheck` 末尾追加了 `tsc --noEmit -p apps/app`,所以根回路也会检查本工程。根目录端到端 `src/daemon/phone-app-live-e2e.test.ts` 会 import 本工程的一部分文件(见下「真连接的规矩」),那些文件要同时过根 tsconfig。

### Maestro

装:`brew tap mobile-dev-inc/tap && brew trust --formula mobile-dev-inc/tap/maestro && brew install --formula mobile-dev-inc/tap/maestro`(注意是 formula;不带 `--formula` 会装成桌面版 Maestro Studio 的 cask)。要 Java,formula 会带上 openjdk。

| 流程 | 走什么 |
|---|---|
| `.maestro/approve.yaml` | 先看看 → 此刻第一张「等你决定」卡 → 批准页**原始命令直接可见** → 允许 → 进展页 → 2 秒后「这一轮已回复」 |
| `.maestro/chat.yaml` | 此刻 → 跟 CC 说一句 → 对话页 → 发一句 → 「在想…」→ 演示回复出现 → 一起做的置顶「和 CC 的对话」回到对话页 |
| `.maestro/chat-extras.yaml` | 跟 CC 说 → 发一句 → 演示回复带「过程 · 2 段」(默认收起)、语音、本地表情(图)、联网表情(只写情绪)→ 展开过程看到「没有发到微信」→ 点语音不报错(2026-10-04) |
| `.maestro/connections.yaml` | 设置 → CC 的连接卡(演示数据)→ 各项状态词 → 电脑上的会话列表(只读) |
| `.maestro/compose.yaml` | 此刻 → 跟 CC 说 → 显式选「交给 CC 去做一件事」→ 输入 → 交给 CC → 新事项的进展页 → 「一起做」里出现它(交办不再是默认动作) |
| `.maestro/worktree.yaml` | 一起做 → 整理笔记那件(独立分支 cc/notes001)→ 提交到分支 → 合回项目(点两下)→「已合回」→ 删除工作区(点两下)→ 重新打开 →「交给另一位另做一份」进交办页:项目、独立工作区、从分支开始都在,执行者换成另一位(2026-10-08) |
| `.maestro/quota-handoff.yaml` | 一起做 → 周报那件(Claude Code 额度用完)→ 灰字 +「交给 Codex 继续」→ 确认卡如实说(同一文件夹新开一件、原来那件不动、Codex 看不到之前的对话、会用 Codex 的额度)→ 交出去 → 进新那件 → 返回,原来那件说「已经交给 Codex 继续」 |
| `.maestro/demo-walkthrough.yaml` | 欢迎 → 先看看 → 此刻 → 一起做 → 某件事 → 展开改动 / 过程 → 设置 → 切语言 → 退出演示回欢迎页 |
| `.maestro/pair-invalid.yaml` | 欢迎 → 配对 → 粘贴无效链接 / 局域网链接 → 各自的提示(不联网;真配对是主人真机验收) |
| `.maestro/pair-link.yaml` | 开发构建用自定义 scheme 打开配对链接 ⇒ 确认卡出现、显示中继主机与核对码、没有自动配对;再开一个锚点丢了的链接 ⇒ 「没带全」提示 |
| `.maestro/subflows/_start.yaml` | 共用开头:`clearState` 启动、收掉开发构建偶尔弹的系统框「Open in "Tendhearth"?」、等欢迎页 |

同时开着多台模拟器时加 `--device <UDID>`。流程只认 `testID` 和中英两份文案(正则 `中|英`),不依赖系统语言。

### 真机全自动验收(scripts/device-e2e.ts,2026-10-01)

USB 连着一台 iPhone、daemon 在跑并已连上中继 v2(`relay_v2_url`),一条命令跑完配对 → 跟 CC 说一句 → 真推送点开批准 → 撤销,没人碰屏幕:

```bash
bun run e2e:device                      # = bun scripts/device-e2e.ts;第一次会 prebuild + 构建(几分钟),之后增量
bun scripts/device-e2e.ts --skip-build  # 包没变时只跑步骤
bun scripts/device-e2e.ts --executor codex   # 批准那一步换执行者(默认 claude;cursor 额度用完时会直接报)
bun scripts/device-e2e.ts --only chat,push   # 只跑部分(配对与收尾总是跑);--build-only 只构建 + 安装
```

报告:`<tmpdir>/tendhearth-device-e2e/<时间>/report.md`(+ `report.json`、失败步骤的截图、每步的 `xcresult/`、`logs/`),不进 git。退出码 0 全过 / 1 有步骤失败 / 2 要主人在手机上动一下(报告里写了是哪一件)。

| 步骤 | 自动断言 |
|---|---|
| 收起主人的配对 | `tendhearth://dev-e2e?op=stash`:手机原有的配对搬进收纳格(见下「为什么要收起来」) |
| a 配对 | `POST /v1/phone/link`(= 桌面「连接手机」)铸一次性码 → 自定义 scheme 链接经 `devicectl --payload-url` 送进 app(不用相机)→ 确认卡的核对码 = daemon 给的、显示中继主机 → 点连接 → 此刻顶栏「家里的电脑 · 在线」(与 CC 亮同一个判定)→ daemon 多出恰好一台设备 |
| a' 重用 | 同一链接再开 → 连接 ⇒「已经用过或过期」,daemon 设备数不变;返回回到此刻且仍在线 |
| a'' 推送登记 | 测试设备把 APNs 令牌登记到 daemon(`phone-push.json` 只读键名) |
| b 跟 CC 说 | 此刻 → 说一句 → 打字发送 ⇒ 自己的气泡 ⇒ 一条发送前没有的 CC 气泡 |
| c 真推送 + 批准 | app 退后台 → 派一个要删探针文件的工作台任务 → SpringBoard 上出现**扩展解密后**的横幅(标题「需要你批准」+ 任务名;占位「CC 有新动态」不算)→ 点开 → 批准页 → 允许 → 进展页;daemon 那头权限清空、任务答完、探针被删 |
| d 撤销 | 局域网 `revoke_device`(设置页「忘掉」同一个 op)⇒ app 此刻页「这台手机已不再配对」 |
| e 收尾(无论成败) | 取消 + 归档任务、删 scratch、测试设备还在就撤、`dev-e2e?op=restore` 放回主人的配对、冷启动确认主人那台重新在线 |

**为什么用 XCUITest 不用 Maestro**:Maestro 2.11 对这台 iOS 27 真机直接报 `Device … is not connected`(它这版只认模拟器);XCUITest 能接管正在跑的 app(`XCUIApplication(bundleIdentifier:)`,步骤之间不重启)、能点 SpringBoard 的通知横幅 / 通知中心 / 权限框。UI 测试 target 由 `plugins/with-ios-uitests.js` 在 `TENDHEARTH_UITESTS=1` 的 prebuild 时加进工程(源码 `native/ios-e2e/`),平常的 prebuild / EAS 构建里没有它;每一步是一次 `xcodebuild test-without-building -only-testing:…`,参数走 `TEST_RUNNER_*` 环境变量,结果是 stdout 里的 `E2E_OUT 键=值`。

**为什么是 Release 包 + `e2eBuild` 标记,不是开发构建**:Expo SDK 57 的 Debug 包把 JS 打进包里跑会启动即红屏(`Cannot create devtools websocket connections in embedded environments`),还会去局域网找 Metro(弹「查找本地网络中的设备」)。所以构建 Release(JS 在包里、沙盒 APNs),`app.config.js` 在 `TENDHEARTH_UITESTS=1` 时写 `extra.e2eBuild = true`(`src/e2e-build.ts`):只打开自定义 scheme / staging 主机的配对链接与 `dev-e2e` 页;`dev-push-key` 与开发令牌兜底仍只认 `__DEV__`。构建时也要带这个环境变量(expo-constants 在 xcodebuild 里再求一次 app.config),脚本会核对包里的 `EXConstants.bundle/app.config`。

**为什么要收起来**:验收常在主人自己已配对的手机上跑。直接配一台测试设备,app 会去退掉旧设备位(`retirePrevious` ⇒ `unpair_self`)—— 就把主人的配对撤了;测完撤销测试设备又让 app 停在「不再配对」。`dev-e2e?op=stash` 把配对记录搬进钥匙串收纳格(`state/e2e-stash.ts`,已有一份就不覆盖),`op=restore` 原样搬回并删推送登记指纹(下次启动按原来那台重新登记推送)。令牌只在钥匙串里搬,不进日志。脚本中途被杀:报告最后一行写着怎么手动放回;重跑一次也会放回。

**要主人做的(自动化做不了)**:手机解锁、亮屏(自动锁定设「永不」,跑完改回);开发者模式开着;每次手机重启后第一次跑 UI 测试,手机会弹「Enable UI Automation · 使用触控 ID 以继续使用 XCTest」,要验证一次触控 ID(没人验证 ⇒ runner 报 `认证已取消`,脚本退出码 2 并写明)。

**已知**:主人原来那台设备位也登记着同一个 APNs token 时,没带 2026-10-01 修复的 daemon 会给同一部手机发两条(collapse-id 相同,后到的顶掉前一条;原来那台的推送密钥已收起,那条只能显示占位,点开落在此刻)。步骤会等横幅落定、只点解密后的那条;落在此刻会写 `landed_on_now`。daemon 部署了「同一 token 换设备位 ⇒ 旧设备位让出登记」(`src/daemon/phone-push.ts`)之后就不会再有第二条。

**抓到并修掉的**(2026-10-01 首轮真机):① iOS 上 `getDevicePushTokenAsync` 每调一次都会回调 `addPushTokenListener`,监听无条件强制重登 ⇒ 每 0.6 秒一次 `POST /m/api/push/register` 的重试风暴(主人原来装的包也在刷,daemon 日志一小时近千行)—— `push/register.ts makeTokenWatch` 只认真变了的 token;② 已配对的手机从系统链接冷启动进配对页、点返回,落到欢迎页回不到此刻 —— `view/pair.ts pairBackTarget`;③ 同一部手机两个设备位都登记推送 ⇒ 重复通知(上一条)。

## 目录

```
src/app/          expo-router 页面:(tabs)/ 此刻 index + 一起做 together;welcome、pair、compose、settings、
                  matter/[id](进展页)、approval/[id](批准页 + 问答表单)
src/backend/      Backend 接口(types.ts)与演示后端(demo.ts + demo-data.ts 的中英文案)
src/net/          真连接:connection.ts(连接状态机)、errors.ts(错误映射)、link.ts / pairing.ts(配对链接与配对)、credentials.ts(钥匙串)、ws-socket.ts / rn-connect.ts(RN 传输)、uuid / utf8 / polyfills
src/state/        BackendProvider、会话(语言覆盖、已看过欢迎页;配对记录与偏好落钥匙串 `tendhearth.pairing.v1` / `tendhearth.prefs.v1`)、订阅 store、查询 hooks、草稿
src/view/         纯函数视图模型(此刻 / 一起做 / 进展 / 批准 / 状态词),vitest 覆盖
src/i18n/         en 与 zh-Hans 文案表(两份键一致有测试)+ useLang(设置覆盖 ?? 系统)
src/ui/           组件与色板(tokens.ts,复用共享 design-tokens;固定暖纸,CC 明暗由真实信号决定)
src/push/         推送:key-store(钥匙串里的推送密钥记录)、target / route(点通知去哪)、register(登记生命周期)、PushProvider / PushRouter、前台横幅、开发用 dev-token
native/           原生通知核心:ios-notify(Swift 通知服务扩展 + `swift test`)、android-push(Kotlin 消息服务 + JVM 单测 `test.sh`)、push-strings.json(原生端标题文案)
plugins/          Expo config plugin:with-ios-notify(扩展 target + 共享钥匙串)、with-android-push(FCM 服务 + 读 expo-secure-store)、with-ios-scene(iOS 27 场景委托)、with-ios-uitests(真机验收的 XCUITest target,只在 TENDHEARTH_UITESTS=1)及其测试
native/ios-e2e/   真机验收的 XCUITest 步骤(scripts/device-e2e.ts 逐步调用)
locales/          iOS InfoPlist 本地化(相机说明 + 显示名,en 与 zh-Hans)
scripts/          sim-push.ts:模拟器推送工具(合成开发令牌 + simctl push)
.maestro/         模拟器演示流程
```

## 界面只认 Backend 接口

页面只通过 `src/backend/types.ts` 的 `Backend` 拿数据和提交动作(订阅主题、`matter` / `insight` / `changes` / `decide` / `answer` / `say` / `create` …)。演示后端在 `src/backend/demo.ts`:四件种子事(作品集 `a1b2c3d4` 带一条模型说明的待批准、零散想法 `e5f6a7b8` 已回复、出差 `c9d0e1f2` 带一个问题、周报 `f3a4b5c6` Claude Code 额度用完可交给 Codex),动作后 2 秒推进到「这一轮已回复」;设置里「退出演示」会重置。
真后端在 `src/backend/live.ts`(纯 TS,socket 注入);连接状态机 `src/net/connection.ts`;错误映射 `src/net/errors.ts`;配对 `src/net/pairing.ts` + `src/app/pair.tsx`;钥匙串 `src/net/credentials.ts`(键 `tendhearth.pairing.v1` / `tendhearth.prefs.v1`)。界面不用关心用的是哪个。

## 真连接的规矩

- **只走中继**:`r…` daemon id ⇒ `wss://<中继主机>/v2/phone?id=<id>`;`t…` id ⇒ `wss://<中继主机>/tunnel/phone?id=<id>`。链接里的 `lan=` 解析并记下,但**不使用**(daemon 的局域网口没有 v2 订阅,见计划裁决 1)。
- 所有接口返回都过 `PHONE_API_SCHEMAS` 的 zod schema,主题事件过各自的 Topic schema;解析失败 ⇒ 事件丢弃并记日志,请求抛 `BackendError('unknown')`。
- 错误映射只在 `src/net/errors.ts` 一处:`permission_stale / question_stale / input_stale` ⇒ `stale`;`auth_failed` 或 HTTP 401 ⇒ `revoked`;`timeout` ⇒ `timeout`(界面当「不确定」);`unreachable / daemon_offline / closed / stream_unknown / rate_limited / quota_exceeded / too_many_streams` 及未知传输错误 ⇒ `offline`(例外:请求在飞时是本机自己关的连接——进后台 / dispose / 撤销——`live.ts` 报 `timeout`,撤销了则报 `revoked`:那一条可能已经送到);`matter_not_found` ⇒ `not_found`;`invalid` 与 `invalid_*`(含 `invalid_answer`)⇒ `invalid`;其余 ⇒ `unknown`。
- 说一句与交办的 `requestId` 按草稿稳定(`state/drafts.ts` `requestIdFor`:同一份草稿、同样正文重发用同一个,正文改了才换,发成功删草稿时一起丢)。daemon 两条说一句都按它去重:工作台任务走工作台输入回执;微信聊天那件事走 `matter_say_receipts`(2026-10-01,v70)——同 id 同文重发拿回原来的回复(在跑就跟上同一轮),同 id 异文 ⇒ 409 `input_conflict`,那一轮失败不留回执(重发 = 重试),daemon 重启打断的那句当已收下、不再说。
- 上限:回答 `JSON.stringify(answers).length > 20_000`、说一句正文 `> 20_000` 字,在手机上就拦下,不发(协议包常量 `PHONE_ANSWER_MAX_JSON` / `PHONE_SAY_MAX_CHARS`)。
- **跟 CC 说走 `/m/api/chat*`,收下即回**:`/m/api/chat/say` 立刻返回(走 companion 路径,与微信同一个主人会话),回复靠 `matter/<聊天>` 主题唤醒后拉取;一次只等一句(上一句在等 ⇒ 409 `chat_busy`,草稿留着),10 分钟超时。`requestId` 用 `requestIdFor('chat', 正文)`。老网页壳 `/m/api/matter/say` 的同步语义不动。主人的对话在「一起做」里置顶;访客的聊天不出现在手机上。
- **「可能没送到」**:本机收过回执,但 daemon 那边既不 pending 也没历史 ⇒ 显示未确认气泡(可重试、可忽略);重试用同一个 `requestId`,daemon 去重,所以即使其实已落在历史别页也安全。原因:任务表只在内存,daemon 重启会丢正在等的那句。不自动重发(不重试风暴)。
- **连接卡与会话页拿到的都是 admin 以下的投影:没有路径**(无插件目录、无 cwd / nativeId)。连接卡「不知道」永不显示成绿;知识库没开不是故障(不显示红),开了没建起来才红;知识库陈旧按最近一次同步判,微信聊天记录的日期按 wxvault 解密时间。会话列表查询只读、只给目录名；#166 另提供确认后「接着做」的写入入口，查询投影与续接授权分别验收。
- **额度用完交给另一位**(spec continue-sessions §7-3):详情的 `quotaHandoff`(daemon 算:`offer` / `none` / `handed`)⇒ 进展页底部一块;确认卡确认后 `POST /m/api/matter/handoff {id, requestId, providerId}`,`requestId` 每次点开卡换一个、卡里重试沿用,daemon 按它幂等、一件事也只交一次。`quota_handoff_*` ⇒ `handoff_changed`(重读详情,不说「没送到」)。与微信「交给 X 继续？」同一个信号、同一个动作。
- **撤销 ≠ 离线**:撤销 ⇒ 停止提交、清掉钥匙串里的设备令牌、显示「重新配对」;暂时离线 ⇒ 显示上次同步时间、草稿照写、发送 / 批准 / 拒绝锁住。两者文案与 testID 都不同。
- **草稿永不自动发送**:重连后只重拉读,不重放写;不做乐观成功。
- **令牌不进日志**、错误文案或 `console`:`LiveBackend` 的 `log` 只写错误码与路由键。
- **被根测试 import 的文件必须纯 TS 且过根 tsconfig**:`src/backend/{live,types}.ts`、`src/net/{connection,errors,uuid,link,pairing}.ts`、`src/push/{key-store,target,route,register}.ts`、`src/i18n/{index,en,zh-Hans}.ts` 不 import `react` / `react-native` / `expo-*`;类型用 `import type`,数组下标取值带 `!` 或判空(根有 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`)。

## 推送(原生通知)

计划:`docs/superpowers/plans/2026-09-30-tendhearth-app-push.md`。

### 本机能验证什么(2026-09-30 探路,Xcode 27 / iOS 27.0 模拟器)

- `xcrun simctl push` 会不会运行通知服务扩展:**no**(`NSE_UNDER_SIMCTL=no`。app 在后台、已 `registerForRemoteNotifications` 拿到令牌、扩展已被 PlugInKit 登记,横幅仍是原样的 `CC / CC 有新动态`,日志里没有 `nse ran`、没有扩展进程;`simctl push` 走 CoreSimulatorBridge 直接把请求交给 SpringBoard,不经过 apsd 的 mutable-content 管线)。
- 模拟器上 app 与扩展共享钥匙串组:**yes**(`SHARED_KEYCHAIN_ON_SIM=yes`。主 app 往 `9Y6JAPDP7A.<…>.shared` 写 `SecItemAdd = 0`;另一个只带共享组 entitlement 的 bundle 不指定 access group 读到 `0` / 原值;反证:它往没授权的组写得 `-34018`,即模拟器真的按 entitlement 管。扩展进程本身在模拟器上跑不起来,所以「扩展读」是用同样 entitlement 形状的第二个 bundle 代测的)。
- 模拟器构建的签名参数:`无需额外参数`(`DEVELOPMENT_TEAM=9Y6JAPDP7A` 时 Xcode 用「Sign to Run Locally」,entitlements 以 simulated entitlements 嵌进二进制,`$(AppIdentifierPrefix)` 展开成 `9Y6JAPDP7A.`)。另:扩展 bundle id 必须以主 app 的为前缀,否则构建报 `Embedded binary's bundle identifier is not prefixed with the parent app's bundle identifier`。
- 因此扩展的解密 / 展示逻辑在本机只能靠 `native/ios-notify` 的 `swift test` 与直接调 `didReceive` 的单测验;模拟器上 `simctl push` 只能验「app 收到原样推送 + 点开路由」。
- 真 APNs / FCM 投递、锁屏、进程被杀后的送达:只能真机 + 主人的 APNs 密钥 / Firebase 项目(见文末「主人要做的」)。

### 在模拟器上验通知(scripts/sim-push.ts)

模拟器用 iOS 26.5 的 `th-push`(`xcrun simctl create th-push com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5`;iOS 27 的启动崩溃已由 with-ios-scene 修掉,`th-push-27` 验过),装开发构建、`bunx expo start --clear --dev-client` 在跑。

1. app 开着、点「先看看」进了演示:`bun apps/app/scripts/sim-push.ts --print-link | xargs xcrun simctl openurl <udid>`(系统问「在 Tendhearth 中打开?」点 Open)⇒ 页面出现 `dev-push-key-ok`。这一步:把开发令牌推出的推送密钥写进共享钥匙串、要一次通知权限(演示不配对,登记流程不会去要)、并把开发令牌记在内存里给 app 兜底解密(`src/push/dev-token.ts`;只在开发构建、且没配对时用;app 被杀就忘)。注意:只有开发令牌本身在内存里,它推出的推送密钥写进了共享钥匙串、会留下来(直到下次冷启动没配对时清掉)。已配对的开发构建里这个链接什么都不写(页面显示 `dev-push-key-paired`),免得顶掉真配对的推送密钥。
2. 发:`bun apps/app/scripts/sim-push.ts --udid <udid> [--mode ok|stale|tamper|wrong-key] [--repeat [--gap <ms>]]`。载荷与中继发给 APNs 的同形(占位 alert + mutable-content + `wcc` 真密文,用协议包 `sealPush` 封)。
3. 点系统横幅:Maestro 点不开通知中心 / 锁屏里的通知,但能点正在显示的横幅 —— 先在后台起一个反复点 `point: 50%,9%`、直到 app 里出现目标 testID 的流程,再发推送。

2026-09-30 的结果(th-push,iOS 26.5;`NSE_UNDER_SIMCTL=no` ⇒ 分支 B,扩展不跑):

| # | 场景 | 观察 |
|---|---|---|
| 1 | app 在后台,`--mode ok` | 系统横幅是中继原样的「CC / CC 有新动态」(扩展没跑) |
| 6 | 点 #1 的横幅 | app 回前台 → 中转页 → 批准页 `approval-title`,原始命令 `npm install sharp` 可见(app 用兜底密钥在 app 里解开 `wcc`) |
| 2–4 | 后台,`--mode stale` / `tamper` / `wrong-key`,先停在批准页再点横幅 | 横幅同样是占位;点开 ⇒ 此刻(`now-needs-you-card`),没进中转页 |
| 7 | app 在前台,`--mode ok` | 不弹系统横幅;app 顶部 `push-banner` 显示解开的「CC / 整理作品集:npm i sharp」;点它 ⇒ 批准页 |
| 7' | 前台,`stale` / `tamper` / `wrong-key` | `push-banner` 只显示中性「CC / CC has news」(英文系统);点它 ⇒ 此刻(从批准页出发也一样) |
| 5 | 前台,`--repeat --gap 9000`(同一份密文送两次) | 第一份弹横幅、6 秒自动收起;第二份到达后不再弹(按密文去重)。系统通知中心里每条都单独列出 —— simctl 不带 apns-collapse-id,不合并 |
| 8 | 杀掉 app 后发 `ok`、点横幅 | 冷启动到欢迎页:演示模式下「看过欢迎页」与开发令牌都只在内存里,冷启动都没了(钥匙串里那把开发推送密钥冷启动时也因为没配对被清掉)(已配对的用户两样都在钥匙串里,但这条只能真机验) |

只能真机验的:扩展解密后的系统横幅标题 / 正文与本地化、扩展里的去重与 passive、collapse-id 合并、已配对时冷启动点通知直达批准页、锁屏与进程被杀后的送达。扩展的逻辑本机只由 `swift test`(`native/ios-notify`)覆盖。

开发令牌是合成的(`dev` + 48 位 hex),不是任何真设备的令牌;`/dev-push-key` 在发布构建里不生效(深链改回此刻、页面本身也重定向),dev-token 兜底在发布构建里不用。

### 规矩

- 通知从不执行操作(category 无动作):点开只进 app,批准在批准页里做。
- 扩展 / 消息服务**只拿推送密钥记录** `{v,key,lang}`,拿不到设备令牌(令牌能以这台手机的身份操作电脑,扩展只需要解密)。主 app 的 `keychain-access-groups` 把自己的组排第一,保证不带 accessGroup 的写入(配对记录)不落进共享组。
- 令牌、推送密钥、token 不进日志。解不开 ⇒ 中性占位(「CC / CC 有新动态」);标题按 `kind` 在原生端本地化(`native/push-strings.json`,改文案两种语言一起改),正文是用户自己的数据原样显示。
- 重复推送 iOS 只能静音(`interruptionLevel = .passive`,丢弃要 Apple 特批权限),中继的 `apns-collapse-id`(= taskId)让同一件事只留最新一条;安卓服务直接不发。
- 改钥匙串键名 / service / 格式 ⇒ `src/push/key-store.ts`、`native/ios-notify/Extension/ExtensionStores.swift`、`native/android-push/android/SecureStoreReader.kt` 一起改(`plugins/native-guards.test.ts` 对着 `node_modules` 里 expo-secure-store 的源码钉住,升级时先红)。
- iOS 27 要求 UIScene 生命周期,否则启动即崩;Expo SDK 57 的模板没接,`plugins/with-ios-scene.js` 把 expo 自带的 `EXExpoAppSceneDelegate` 接上。**哪个 Expo SDK 的模板自己采用场景委托了,就删这个 plugin**(它找不到锚点会在 prebuild 时直接报错,不会悄悄产出会崩的包)。
- 开发专用:`tendhearth://dev-push-key` 页与开发令牌兜底(`src/push/dev-token.ts`)只在 `__DEV__` 生效,发布构建里深链改回此刻;开发令牌(`dev…`)形状刻意区别于真设备令牌(`d…`)。

### 怎么跑

```bash
cd apps/app/native/ios-notify && swift test        # Swift(CryptoKit)跑协议包同一份向量
apps/app/native/android-push/test.sh               # Kotlin JVM 单测;第一次联网,之后加 --offline
cd apps/app && bunx expo prebuild --platform ios --clean && (cd ios && pod install) && bunx expo run:ios
```

CI:`app · native push vectors`(`.github/workflows/ci.yml`,仅 `apps/app/native/**` 或 `packages/protocol/**` 变动时跑,macOS runner)。

### 构建环境变量

`TENDHEARTH_APNS_ENV`(development / production,决定 `aps-environment` 与登记平台 `apns_sandbox` / `apns`;`eas.json` 三个 profile 各自设好)、`APPLE_TEAM_ID`(默认 9Y6JAPDP7A)、`GOOGLE_SERVICES_JSON`(EAS 文件型环境变量,或本地 `apps/app/google-services.json`,不进 git)。详见 `app.config.js` 头注释。`eas.json` 已加但**没运行过**;`extra.eas.projectId` 等主人 `eas init` 后提交。

### 模拟器

- `th-push`(iOS 26.5,UDID `8471AD7D-4D54-44E6-8D21-1B4DCBF40CA5`):本计划的模拟器验证与 Maestro 全套都跑它。
- `th-push-27`(iOS 27.0):验证 with-ios-scene 之后 iOS 27 能启动(之前启动即崩),Maestro 5/5。
- Maestro 前 `xcrun simctl keychain <udid> reset`;`export JAVA_HOME=/opt/homebrew/opt/openjdk@21`。

### 当前验收与发布边界

- **安卓在这台 Mac 上没验过**:没有 Android SDK / adb。Kotlin 服务只有 JVM 单测(`test.sh`),编译进 APK 与运行都要等 EAS 构建 + 真机或模拟器。
- **iPhone staging 已有真机记录**：2026-10-01 / 10-02 的 `bun run e2e:device` 通过配对(经深链，不经相机)、同码重用被拒、聊天、后台扩展解密后的 APNs 横幅与点开批准、撤销、收尾；当时 staging 已配 APNs、本机 daemon 已设 `relay_v2_url`。该记录对应当时的验收构建，后续补充持久恢复、附件和普通发布包需各自验收，不能据此宣称主人真手机已经更新。
- **仍需人手的 iOS 验收**：系统相机扫码 / 通用链接、锁屏解密后的文字、进程被杀后点通知冷启动、系统设置拒绝再打开通知权限、撤销后再触发只显示中性占位、加密备份恢复，以及下节聊天 / 会话续接清单。物理 iPhone 的补充日志跨进程恢复仍未实测。
- **TestFlight 发布条件**：按[中继手册](../../docs/maintainer/relay.md#8-上线前后必读--go-live-notes)经 `relay-production` 环境批准部署 production Worker，配置生产 APNs 并核对健康，再将 daemon 的 `relay_v2_url` 切到生产，打开 `RELAY_WATCH`。staging 的成功不代替生产验收。EAS 仍需 `eas init` 提交 projectId，再 `eas build --profile production --platform ios` 与 `eas submit`；App Store Connect 记录和商店提交另办。
- **安卓 / 商店后置**：安卓需要 Firebase 项目、`google-services.json` / `FCM_SERVICE_ACCOUNT`、App Links 签名指纹、SDK / 设备与实际 APK 验收；Google Play 账号与生产构建另办。凭据步骤见[中继手册](../../docs/maintainer/relay.md)。
- **旧欠账已关闭**：#165 配对码只配一台，成功配对即作废，重复码已有真机自动化断言；微信聊天那件事的说一句已按 `requestId` 去重(2026-10-01，`matter_say_receipts`，同 id 同文返回原回执，异文返回 `input_conflict`)。相机权限 en / zh-Hans 文案已由 #158 补齐。

## 硬要求(改界面前先对一遍)

- **批准页**:说明来自模型(`source === 'model'`)时,原始命令第一行与工作目录**不折叠、直接可见**(`approval-raw-inline`,Maestro 断言它);完整原始命令在「查看具体操作」里;提交中锁定按钮;以返回结果为准,不做乐观成功;超时 ⇒ 当「不确定」并重新拉详情。
- **进展页**:状态标签在「CC 的进展」概括之上。
- **状态词**只用:正在整理 / 等你决定 / 这一轮已回复 / 事情完成 / 没做成 / 已停下(Working on it / Waiting for you / Replied this round / Done / Didn't finish / Stopped),不显示百分比。
- **主动作是跟 CC 说**,交办是显式选项(此刻页入口、发送框默认都是说一句,不是建任务;一次一句,等回复时发送锁住并保留草稿)。
- **导航**:底部「此刻 / 一起做」;右上角头像进设置,旁边是「家里的电脑」状态点;说一句的入口随处可见。
- **语言**:`en` 与 `zh-Hans`,跟随系统、设置里可改;所有面向用户的字符串进文案表。
- **隐私页**要说明:打开此刻、进展或批准页时,待批准的命令文本和任务的进展事件会从主人自己的电脑发给那里配置的便宜模型服务商;其余只在手机与电脑之间加密传输(`i18n.test.ts` 钉住)。
- 系统「减少动态效果」时关掉 CC 动作;所有状态都有文字。
- CC 形象只用 `apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png`,不重画。

## 跟 CC 说话计划(2026-10-01)的状态与真机验收

状态：手机聊天已通过 #162 合入 dev，设计统一已通过 #163 合入。10-01 的设计统一采用暖纸、衬线、单一强调色、无深色模式；桌面字体后续已随 1.7.5 更新，手机继续沿用原生色板与打包字体。CC 明暗来自真实连接 / 在场信号，见[设计统一 spec](../../docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md)。配对体验 #165、手机续接会话 #166 和发送拒绝文案 #167 已合入；已记录的 iPhone 自动化覆盖上节配对、聊天和推送批准闭环；以下更完整的主人体验验收仍待补齐。

延后的次要项摘要见 `docs/roadmap.md`。主人真机验收(iOS;安卓有设备再补):

1. 此刻 →「跟 CC 说一句」,问需要微信聊天记录的事 ⇒ 立刻出现自己的气泡 +「在想…」⇒ 回复到达(锁屏切回来也在),回复用到了 wxvault。
2. 微信里跟 CC 聊一句 ⇒ 手机对话页出现那一问一答(标「微信」);往上滑能翻到更早的对话。
3. 等回复时到微信发一句 ⇒ 手机那句显示「正在回微信那边」,**未确认气泡的重试 / 忽略**可用。
4. 「一起做」第一行是「和 CC 的对话」,其下是真实最近在动的任务。
5. CC 的连接卡:微信聊天记录日期与 wxvault 同步时间一致;关掉某个插件后变红;不知道的项不是绿。
6. 设置 → 电脑上的会话:能看到 Claude Code / Codex 会话并读几页(只读)。
7. **对话输入框在真机上能聚焦、键盘不遮挡**(模拟器验不出)。
8. 额度用完交给另一位(spec continue-sessions §7-3):让一个执行者真的用完额度(或等它自己用完),手机进那件事 ⇒ 灰字说约几分钟恢复 +「交给 X 继续」⇒ 确认 ⇒ 电脑上同一文件夹多一件 X 的任务、第一句写着「接替 …（额度用完）」;再点 / 另一台手机点都回同一件。
