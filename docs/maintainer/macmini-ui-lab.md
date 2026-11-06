# Mac mini 离线 UI 测试

主人日常使用的 Mac 不运行图形测试，不接管鼠标、键盘、焦点或窗口，也不运行重型测试与构建。所有测试在下述明确登记的 Mac mini 上执行，默认仍为 `homes-mac-mini` 对应的 `Home’s Mac mini`，没有本机回退。根目录 `AGENTS.md` 是协作规则入口。

## 次级 Mini 的隔离入口（2026-11-01）

Home’s Mini 网络不可达时，可显式选择已信任的家族检查机 `Homebot’s Mac mini`。只接受 `/Users/homebot` 与该机器名的精确组合；不能交换两台机器的用户名，也不接受主人的 Mac。新环境限定为 `/Users/homebot/ci/cc-ui-lab/cc-pet-feel-20261101`，与其他项目分开。

```sh
node apps/desktop/scripts/macmini-ui.mjs status homebot
node apps/desktop/scripts/macmini-ui.mjs embedded-build homebot
node apps/desktop/scripts/macmini-ui.mjs embedded homebot
```

该目标使用 `homebot-mac-mini` SSH 别名；实际地址与私钥不进仓库。需要任务自己的 SSH 配置时，可通过 `CC_UI_SSH_CONFIG` 指向主机上的绝对文件路径，仍强制已知主机校验、关闭代理和 X11 转发。未指定目标时保持原来的 Home’s 入口，不自动切换机器。

次级入口同时持有自己的 `.execution-lock` 和家族 `/Users/homebot/ci/lock`。已有检查锁时不开始测试；结束时核对自己写入的拥有权内容，只释放本次锁。公开 Bun/Cargo/浏览器依赖放在新 lab；安装阶段可以下载公开依赖，测试与 UI 构建仍使用拒绝外连的限制和空状态。原 Home’s lab、全局检查配置、家庭数据、relay 与其他项目不修改。

两台机器使用相同的 QA identifier、debug/production 编译限制与回环4199驱动；新增测试机不放宽生产应用或后台执行限制。具体新环境的安装、离线探针和验收状态以每批回执为准，入口存在本身不代表原生验收通过。

## 已准备的环境

- 测试源码：`/Users/home/cc-ui-lab/cc-motion-drag-20261030/project`。起点为 `a4b8b254` 的单提交浅克隆，没有原仓库历史、忽略文件或账号目录。
- 工具：Bun 1.3.13、Node 26.0.0、Xcode 27.1；专用 Appium 3.9.0 与 Mac2 4.5.1 安装于 `/Users/home/cc-ui-lab/runtime-20261030`。编译器、Cargo registry 和 Chromium 1228 都是公开工具缓存，没有复制签名私钥或 Cargo 凭据。
- Appium 由 mini 自己的 `com.tendhearth.cc-ui-lab.appium` LaunchAgent 启动，只监听 `127.0.0.1:4723`。XCTest 端口同样指定为 `127.0.0.1:10100`。禁用 Mac2 AppleScript 扩展，不使用 relaxed security 或公开监听。
- 原生候选包使用 `com.tendhearth.cc-motion-qa-20261029`，输入对照包使用 `com.tendhearth.cc-native-control-20261030`。执行器拒绝生产 CC、Finder 和 lab 外的应用路径。
- 测试子进程只继承基本系统环境，daemon/workbench 状态使用 lab 内独立目录；不启动真实 CC daemon，不调用模型或微信，不读取日常插件或私人数据库。

从主机运行下面的入口只发送 SSH 请求。身份、回环端点和允许命令在两端检查；没有本机桌面回退，也不转发 SSH agent 或 X11：

```sh
node apps/desktop/scripts/macmini-ui.mjs status
node apps/desktop/scripts/macmini-ui.mjs doctor
node apps/desktop/scripts/macmini-ui.mjs unit
node apps/desktop/scripts/macmini-ui.mjs affected
node apps/desktop/scripts/macmini-ui.mjs browser
node apps/desktop/scripts/macmini-ui.mjs embedded-build
node apps/desktop/scripts/macmini-ui.mjs embedded
node apps/desktop/scripts/macmini-ui.mjs full
node apps/desktop/scripts/macmini-ui.mjs full-platform
node apps/desktop/scripts/macmini-ui.mjs production-build
```

`unit` 检查远端执行边界、拖动控制器与真实页面接线、QA 边界、状态目录/桌面模拟接口的测试环境，以及 Rust 原生单测；`browser` 运行陪伴控制、此刻、状态和动作实验室的 26 条无界面浏览器用例。`full` 运行仓库的 `verify --full`，再运行上述两组检查；**它不包含硬件鼠标验收，在进程检查用例上仍受下面的系统限制**。`full-platform` 单独执行标准 `verify --full`，保留独立目录、空配置、测试替身与串行锁，使用正常的 macOS 进程访问权限；不声称具有系统强制断网的覆盖。入口在 mini 的 `/Users/home/cc-ui-lab/run.mjs`，数据配置在同目录 `active.json`。更换测试快照时由整合者更新这两处；不要从未知目录导入执行器。

一次只允许一组测试。mini 的 `.execution-lock/owner.json` 记录所属进程；意外退出留下锁时，先确认这个进程及其测试子进程都已结束，再处理锁，不能抢占另一个执行者。每轮日志和结果位于 lab 下 `artifacts/<时间>-<命令>/`。

`production-build` 仅在 mini 编译完整应用，不启动生产身份的程序。它关闭发布更新包与签名，只使用公开依赖和指定的公开 `sd-cli` 工具；不需要模型权重、私人插件或签名私钥。完整包回到主机后由整合者签名并核对身份，再走部署保护。

## 离线边界

`embedded-build`、`embedded`、无界面浏览器、Rust、`affected` 与 `full` 通过 mini 的 `offline-tests.sb` 运行，允许回环请求并拒绝外连。实际探针确认 `127.0.0.1` 可用，向保留的外部地址建立连接被系统以 EPERM 拒绝。依赖安装阶段只下载公开开发工具，测试阶段 Cargo 使用 `--offline --locked`。

原生 QA 页面使用现有的合成 API/受限 IPC 包装与独立空状态目录；Appium 不是 CC daemon，不需要模型账号。上述进程网络限制的实测范围是无界面测试子进程，不能据此宣称 Appium 冷启动的任意 GUI 程序都处于同一个网络限制中。原生入口只允许两个已知 QA 包。

## Tauri 应用内测试已跑通

主人后续指定优先应用内驱动。`embedded` 只运行 mini 上的独立 QA 包，使用已发布的 `tauri-plugin-wdio-webdriver =1.5.1`，通过标准 HTTP 协议直接驱动，无需 npm 测试客户端。显式 Cargo feature `qa-webdriver` 只允许 debug、专属 QA identifier，以及 `/Users/home` + `Home’s Mac mini` 或 `/Users/homebot` + `Homebot’s Mac mini` 两对精确身份；发布构建启用该 feature 会编译报错。普通构建不注册驱动，测试服务固定监听 `127.0.0.1:4199`。QA 模式同时拒绝 CLI/daemon 参数和 native CLI 执行。

2026-10-30 在 mini 锁屏状态下，已实际验证真实 WebKit 页面、改变后的非空 PNG 截图、原生后台命令拒绝，以及真实浮窗 240×300 → 269×336 → 240×300 的尺寸变化。截图来自 `WKWebView.takeSnapshot`，不是桌面截屏；像素解码证明存在多种颜色，界面变化后像素摘要不同。整个进程树使用现有离线限制和独立空状态目录，没有系统鼠标输入或 XCTest 授权。

应用内驱动的鼠标事件是 `isTrusted=false` 的 DOM 事件，不产生 AppKit 原始鼠标事件。驱动返回成功不能证明原生窗口拖动；拖动回归必须独立读取实际窗口几何，并记录硬件输入覆盖范围。拖动回归另外通过 WebKit → Rust → AppKit 读取实际位移、尺寸、首次点击策略和关闭前的磁盘保存结果。2026-10-30 基线窗口未移动且原生 `acceptsFirstMouse=false`；修复后在未激活窗口上观察到 AppKit 位移 −80/+40 点，尺寸仍为 240×300，`acceptsFirstMouse=true`。这证明应用内拖动链路，硬件鼠标投递与跨屏捕获仍是覆盖边界。

macOS 使用浏览器全局逻辑坐标的位移与原生窗口起点移动窗口，不再依赖经过异步 IPC 后的 `NSApp.currentEvent`。控制器串行等待原生位置确认，合并中途移动，松手保存实际位置；失焦、取消和控制按钮会结束当前手势。Windows/Linux 保留已有系统拖动。QA 页面只在测试包记录命令完成回执与界面就绪状态；普通构建没有这些标记。每次新开窗口都等待模块绑定结束，读就绪状态采用可恢复的幂等 WebKit 探针，拖动和写命令不自动重试。

## 外部桌面控制仍缺系统授权

2026-10-30：Appium 服务与 WDA 构建成功，但实际 XCTest 会话被 macOS 的 **Enable UI Automation** 系统身份确认阻止；系统同时报告 mini 的图形会话锁定。开机、SSH 在线、屏幕共享服务在线，都不能证明桌面已解锁或输入自动化已获准。主人目前不会远程桌面过去或手动确认，因此真实鼠标测试仍受阻。

`status` 仅读取状态，不创建 UI 会话。`native-smoke` 和 `capture` 在锁屏时退出 2，不发送输入，不切换到主机。桌面可用后，首次 XCTest 连接仍可能出现系统身份确认；不能用 SSH 代替，也不运行免认证自动化命令、不改 TCC、SIP 或系统开发者授权。

```sh
node apps/desktop/scripts/macmini-ui.mjs native-smoke
node apps/desktop/scripts/macmini-ui.mjs capture
```

授权可用后，`native-smoke` 先使用独立 AppKit 对照窗口，检查实际位移、尺寸与原生 down/dragged/up 事件；截图仅取所属 QA 窗口。它只证明输入对照，不证明 CC 已能拖动。它用于补充硬件输入覆盖。当前按主人指定的应用内测试路线，通过真实原生窗口的独立观察验收应用链路；不把模拟 DOM 事件写成硬件输入验收。

应用内拖动回归、独立评审通过后，整合者才合入 dev，在 mini 验证并构建，回到主机进行签名和受保护的整包部署。旧的完整签名 app 保留用于回滚；不在主机补做鼠标验收。

## 2026-10-30 的已取得证据

- QA 原生包完全离线构建成功，未启动真实后台。
- 无界面浏览器原有 26/26 通过；增加拖动回归后原生库单测 85/85、执行边界 8/8、拖动/页面接线/QA 边界 25/25 通过。
- 入口的环境回归 14/14 通过：临时状态属于每轮测试目录，CSP 仅给浏览器回归启用，不污染模拟接口的独立单测。
- 原生库最初 77/78：平台的特权 `ps` 在离线限制中无法启动。断言改用 `waitid(WNOWAIT)` 观察状态，保留“后台已回收子进程”的要求；新增用例区分运行、退出但未回收和已回收，未放宽网络限制。
- SSH `status` 实际返回 mini 的身份、Appium 3.9.0 ready 及桌面 locked；这不是原生交互成功的回执。

整仓 `verify --full` 已实际运行：类型检查、依赖检查和真实形状沙盒 12/12 通过；Bun 8 条、Node 7 条失败，其中状态目录/CSP 的两处入口设置已修复并通过上述 14 条定向复验，其余涉及 `process-tree-freeze.test.ts`、`live-window.test.ts`、`claude-workbench-process.test.ts`、工作台 `service/scripts.test.ts` 的真实系统进程查询。最小对照确认，连仅有 `allow default` 的 Seatbelt profile 也会禁止启动平台特权 `ps`；不是网络拒绝规则导致。没有为这些用例修改生产进程管理、跳过断言或移除离线限制。该严格限制下的全量结果仍记录为失败，不生成全绿凭证。标准仓库回归另设 `full-platform`，不改这些断言、不跳过用例，也不放宽任何 UI 测试的断网限制；其结果单独记录。另检查未遗留这些失败用例的孤儿、停止或僵尸进程，无需清理。

后续结果必须带实际命令、提交与日志；不要把原生包能构建、浏览器拖动样式变化或 IPC 返回成功写成原生拖动通过。

## App / Maestro lane

App 与桌面共用 mini 身份校验、BatchMode SSH、两端命令白名单、执行锁和每轮日志；没有主工作 Mac 回退。App 源码独立登记在 `active.json.appRoot`，不覆盖桌面的 `root`。快照必须来自已审阅的 `origin/dev` 或 `app-maestro-build3`，仅传 Git archive，不复制 node_modules、忽略文件、账号或原生签名材料。

整合者把本仓库 `apps/desktop/scripts/macmini-ui-{protocol,remote,app}.mjs` 与 `macmini-app-snapshot.mjs` 安装到 mini 的 `labHome/app-executor/` 目录。在 lab 根创建两个固定包装器：`app-run.mjs` import `./app-executor/macmini-ui-remote.mjs`，`app-snapshot.mjs` import `./app-executor/macmini-app-snapshot.mjs`。App 的 SSH 目标固定为 `app-run.mjs`，因此桌面整合者切换 `run.mjs` 不影响 App 入口。这是更新可信工具的维护操作，不是向测试协议添加任意 shell 命令；仍与桌面共享 `active.json` 和执行锁。

```sh
# 在主机调用；只传源码，接收器在 mini 持锁创建新目录并原子更新 appRoot。
node apps/desktop/scripts/macmini-app-snapshot.mjs app-maestro-build3
# 也可选择 origin/dev；可选第三参数 homebot，绝不自动切换。
node apps/desktop/scripts/macmini-ui.mjs app-status
node apps/desktop/scripts/macmini-ui.mjs app-prepare  # 只准备公开依赖，允许下载
node apps/desktop/scripts/macmini-ui.mjs app-build
node apps/desktop/scripts/macmini-ui.mjs app-maestro terminal-sessions
node apps/desktop/scripts/macmini-ui.mjs app-maestro push-open
node apps/desktop/scripts/macmini-ui.mjs app-maestro cc-acts
node apps/desktop/scripts/macmini-ui.mjs app-maestro all
```

`app-maestro [flow|all] [home|homebot]` 只接受协议中登记的流程名称，不接受文件路径、选项或任意命令。`all` 枚举快照中所有顶层 YAML，遇到未登记流程拒绝运行；子流程不单独作为套件。每条流程独立保存结果，全套中某条失败不吞掉其余结果。退出非零时看 `app-results.json` 与每步日志；构建失败时流程尚未执行，不能记成断言失败。

首次准备由整合者在 mini 的 lab 内下载公开工具：`app-tools/maestro/bin/maestro`、`app-tools/java/Contents/Home`（Java 21 runtime）及 `app-tools/gems/bin/pod`（需要时将 Ruby 与 libyaml 同样装在 app-tools 内）。不要运行会修改全局 shell 配置的安装器，不用 sudo。`app-status` 只读，不启动模拟器。工具、Expo/Bun 和 Pods 的公开依赖下载是准备阶段；先用 `app-prepare` 在 App 快照中安装锁定的 JS 依赖并缓存 CocoaPods 所需公开资源，之后 `app-build` 的 prebuild、Pods、Release 构建与 Maestro 子进程沿用拒绝外连、允许回环的 `offline-tests.sb`。缺缓存时明确失败，不在测试命令中隐式联网。

构建使用模拟器 SDK、仅模拟器 ad-hoc 签名、Release 内嵌 JS，带 `TENDHEARTH_UITESTS=1` 的模拟器验收标记以支持开发深链，不运行真机脚本或真实配对；不需要 Metro、Apple 账号、设备注册或生产凭据。`app-build` 写与快照对应的构建回执；更换快照必须重新构建。模拟器 device set 与 App 的 HOME 均位于 `appRoot` 下，只选择命名为 `CC UI Lab App` 的自有设备；不选择或清空已有个人模拟器。Maestro 的 PATH 中放置 lab 内 `xcrun` 包装器，所有 `simctl` 子命令显式添加同一个 `--set`；只改 HOME 无法改变 CoreSimulator 默认设备集。Xcode 27 的 xcodebuild 目的地枚举不包含自定义设备集，因此 lane 解压 Maestro 官方 JAR 中的模拟器 runner，通过同一 `simctl --set` 安装与启动，再用 Maestro 自带的 `USE_XCODE_TEST_RUNNER=1` 连接该 runner。其 HTTP 仅监听 `127.0.0.1:22087`；这只接管 runner 生命周期，不修改系统授权。每轮显式安装该快照生成的包，指定 UDID 运行 Maestro，并在结束后关闭自有设备。

与桌面一样，Seatbelt 的证据范围是所启动的构建/驱动子进程；CoreSimulator 系统服务派生的 App 不因驱动在沙盒中就自动获得相同网络限制。只运行无配对演示流程，不能把它当作真实推送、真实中继或模型验收。mini 锁屏或 XCTest 首次系统授权可能阻塞；由主人在 mini 正常解锁/确认，不改 TCC、不绕过身份验证。
