# Mac mini 离线 UI 测试

主人日常使用的 Mac 不运行图形测试，不接管鼠标、键盘、焦点或窗口，也不运行重型测试与构建。所有测试在 SSH 别名 `homes-mac-mini` 对应的 `Home’s Mac mini` 上执行。根目录 `AGENTS.md` 是协作规则入口。

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
node apps/desktop/scripts/macmini-ui.mjs browser
node apps/desktop/scripts/macmini-ui.mjs full
```

`unit` 检查远端执行边界、状态目录/桌面模拟接口的测试环境，以及 Rust 原生单测；`browser` 运行陪伴控制、此刻、状态和动作实验室的 26 条无界面浏览器用例。`full` 运行仓库的 `verify --full`，再运行上述两组检查；**它不包含原生鼠标验收，目前也未全绿**。入口在 mini 的 `/Users/home/cc-ui-lab/run.mjs`，数据配置在同目录 `active.json`。更换测试快照时由整合者更新这两处；不要从未知目录导入执行器。

一次只允许一组测试。mini 的 `.execution-lock/owner.json` 记录所属进程；意外退出留下锁时，先确认这个进程及其测试子进程都已结束，再处理锁，不能抢占另一个执行者。每轮日志和结果位于 lab 下 `artifacts/<时间>-<命令>/`。

## 离线边界

无界面浏览器、Rust 和仓库测试通过 mini 的 `offline-tests.sb` 运行，允许回环请求并拒绝外连。实际探针确认 `127.0.0.1` 可用，向保留的外部地址建立连接被系统以 EPERM 拒绝。依赖安装阶段只下载公开开发工具，测试阶段 Cargo 使用 `--offline --locked`。

原生 QA 页面使用现有的合成 API/受限 IPC 包装与独立空状态目录；Appium 不是 CC daemon，不需要模型账号。上述进程网络限制的实测范围是无界面测试子进程，不能据此宣称 Appium 冷启动的任意 GUI 程序都处于同一个网络限制中。原生入口只允许两个已知 QA 包。

## 原生控制仍缺系统授权

2026-10-30：Appium 服务与 WDA 构建成功，但实际 XCTest 会话被 macOS 的 **Enable UI Automation** 系统身份确认阻止；系统同时报告 mini 的图形会话锁定。开机、SSH 在线、屏幕共享服务在线，都不能证明桌面已解锁或输入自动化已获准。主人目前不会远程桌面过去或手动确认，因此真实鼠标测试仍受阻。

`status` 仅读取状态，不创建 UI 会话。`native-smoke` 和 `capture` 在锁屏时退出 2，不发送输入，不切换到主机。桌面可用后，首次 XCTest 连接仍可能出现系统身份确认；不能用 SSH 代替，也不运行免认证自动化命令、不改 TCC、SIP 或系统开发者授权。

```sh
node apps/desktop/scripts/macmini-ui.mjs native-smoke
node apps/desktop/scripts/macmini-ui.mjs capture
```

授权可用后，`native-smoke` 先使用独立 AppKit 对照窗口，检查实际位移、尺寸与原生 down/dragged/up 事件；截图仅取所属 QA 窗口。它只证明输入对照，不证明 CC 已能拖动。CC 还需用真实原生输入复现故障、修复，再检查位移、松手停止、点击/双击、控件和位置恢复。注入应用内部的模拟事件不能替代这个验收。

**当前不部署到日常 CC。** 真实原生拖动通过后，整合者才合入 dev、在 mini 验证并构建，回到主机进行签名和受保护的整包部署。旧的完整签名 app 保留用于回滚；不在主机补做鼠标验收。

## 2026-10-30 的已取得证据

- QA 原生包完全离线构建成功，未启动真实后台。
- 无界面浏览器 26/26 通过，原生库单测 79/79 通过，执行边界测试 6/6 通过。
- 入口的环境回归 14/14 通过：临时状态属于每轮测试目录，CSP 仅给浏览器回归启用，不污染模拟接口的独立单测。
- 原生库最初 77/78：平台的特权 `ps` 在离线限制中无法启动。断言改用 `waitid(WNOWAIT)` 观察状态，保留“后台已回收子进程”的要求；新增用例区分运行、退出但未回收和已回收，未放宽网络限制。
- SSH `status` 实际返回 mini 的身份、Appium 3.9.0 ready 及桌面 locked；这不是原生交互成功的回执。

整仓 `verify --full` 已实际运行：类型检查、依赖检查和真实形状沙盒 12/12 通过；Bun 8 条、Node 7 条失败，其中状态目录/CSP 的两处入口设置已修复并通过上述 14 条定向复验，其余涉及 `process-tree-freeze.test.ts`、`live-window.test.ts`、`claude-workbench-process.test.ts`、工作台 `service/scripts.test.ts` 的真实系统进程查询。最小对照确认，连仅有 `allow default` 的 Seatbelt profile 也会禁止启动平台特权 `ps`；不是网络拒绝规则导致。没有为这些用例修改生产进程管理、跳过断言或移除离线限制。全量结果仍记录为失败，不生成全绿凭证。另检查未遗留这些失败用例的孤儿、停止或僵尸进程，无需清理。

后续结果必须带实际命令、提交与日志；不要把原生包能构建、浏览器拖动样式变化或 IPC 返回成功写成原生拖动通过。
