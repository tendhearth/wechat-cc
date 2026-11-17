# 桌面一键安装并登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 桌面接入卡可打开可见终端完成官方安装与登录，并自动检测接入。
**Architecture:** 命令事实集中在 daemon 的 executor facts 旁；WebView 只传 provider/action，Tauri 复用 operator 通道取得白名单脚本。网络安全由现有 guard 判定；安装检测、晚注册和连接检测复用现有实现。
**Tech Stack:** TypeScript、桌面 JS、Tauri Rust。
**Spec:** 主人 2026-11-16 已点头的本任务说明（本轮用户消息）。直接执行，不重复请求产品确认。

## Global Constraints

- 只写本工作区 one-click-cli-setup，基线 31927236d（grok-acp-executor）；不暂存、不提交。
- 本机不启动终端/安装器/登录，不控制窗口，不 listen，不动 daemon/生产数据/应用；Rust 不编译。
- 五家 CLI；agy 不提供安装器；只有 Grok 标免费、额度有限。Windows 只放行官方 PowerShell 安装器。
- Grok 必须用 grokLoginCommand 与 CC 专属 HOME；脚本没有密钥。

## Review Focus

- provider/action 注入及额外 command 字段：在 daemon 和 Rust 边界拒绝。
- guard 关闭、未知、失联或非 bx：禁止安装与登录；发起时重新检查。
- 新装后 registry 没有 provider：复用现有注册闭包补入，不重启 daemon。
- 超时、切换卡片、重复点击、网络中断：不误报接入、不无限轮询。
- Windows PowerShell 与 Grok HOME 引号：使用假执行器/纯构造测试；不真机执行。

### Task 1: daemon 事实与安全接口
- [x] 先加失败测试：官方命令、只登录、agy 无安装、Grok HOME、Windows、严格输入、网络拒绝。
- [x] 实现单一事实、setup 元数据/脚本路由；复用 guard 状态与实时 check。

### Task 2: 检测与晚注册
- [x] 先加失败测试：按 provider 测试、不测其他家、新装晚注册、Grok 本地登录状态。
- [x] 复用现有 binary/probe/register/llm-health，明确 Grok 不支持 eval 的状态边界。

### Task 3: 原生与桌面
- [x] 先加 Rust 假 launcher 测试（留 CI）及桌面 DOM/假时钟失败测试。
- [x] 实现 0700 临时 .command + 固定 open -a Terminal：和 reveal 同类，不增加 AppleScript Automation 权限；Windows 可见 PowerShell。
- [x] 桌面使用 daemon 下发信息，次要复制入口；自动检测、超时重检；移动/微信缺接入文案。

### Task 4: 验证与交接
- [x] 运行轻量牵连单测、类型检查、路由生成检查；独立只读评审。
- [x] 在本文补上红绿证据、文件清单和 mini/真机待验；不运行完整重型 verify。


## 交接（2026-11-16）

负责人：本工作区执行者；整合者负责后续合入/部署。分支 `one-click-cli-setup`，起点 `31927236d`；改动全部未暂存、未提交，没有部署。

### 改了哪

- `src/lib/executor-cli-setup.ts`：唯一的可执行安装/登录命令表；名字取 executor-facts。五家元数据由 daemon 下发；agy 只有官网/已安装后的登录；只有 Grok 标「免费可用 · 额度有限」。不假定 Homebrew/Node。
- `src/daemon/cli-setup*.ts`、`internal-api/routes-cli-setup.ts`：只接精确 provider/action，拒绝多余 command；启动计划只给 admin/operator。元数据与原生都用现有 guard：bx + safe + enabled，off/probe/未知均阻止。按单家进行的现有 health 检测只准本机 file 凭据或 operator，模型 session 不能触发晚注册。
- `bootstrap/providers.ts`、`index.ts`、`module.ts`、`wire-model-options.ts`：复用原 probe/注册闭包处理后安装；Claude 下次 SDK spawn 热取路径；可信 binary 的目录加入脚本 PATH，兼容 nvm 与自定义位置。`util.ts`、`find-codex-binary.ts` 补官方安装根与 Windows cmd shim。
- `grok-home.ts`：沿用 grokLoginCommand，补 PowerShell、USERPROFILE、可信 binary 引用；清除继承的 Grok 凭据路径。安装器本身也用隔离 HOME/XDG，二进制留在标准可发现目录，防止读取主人已有登录。[官方安装器](https://x.ai/cli/install.sh)确实会查已有 auth 文件。
- Grok 没有 eval 探针：可见终端登录成功退出后写一个只有 `ok` 的回执；配合既有专属 HOME 检测和 registry 才显示接入。旧 auth 文件不能单独造成成功。回执读取后删除，新一轮作废旧回执，15 分钟过期；没有新造模型探测。
- `apps/desktop/src-tauri/src/cli_setup*.rs`、`lib.rs`：只接受白名单 ID/action，走既有 workbench_call/operator 通道。macOS 写私有 0700 目录与 0700 `.command`，固定 `/usr/bin/open -a Terminal`；启动失败立即清理，成功由脚本 EXIT trap 清理。选它是因为与 reveal 同类、不需要 AppleScript Automation 权限或二次字符串转义。QA 构建拒绝真实启动。
- Windows 用 CREATE_NEW_CONSOLE + PowerShell，无隐藏窗口/ExecutionPolicy bypass。官方安装器在可见窗口内的固定 `$PSHOME` 子进程执行，成功后刷新 User/Machine PATH 再登录，失败不继续。Cursor/Grok 的既有 Windows ACP 限制保留并在 UI 说明，不能假报已接入。
- `apps/desktop/src/modules/cli-setup.js`、`dashboard.js`、`main.js`：按钮、次要复制、10 秒间隔检测、5 分钟超时及重检；关闭/切卡/迟到响应作废；正常 guard tick 保留超时提示，新机 cached health tick 不吞向导。
- `packages/protocol/src/routes.ts` / `desktop-calls.ts` 及生成物：仅新增 setup 两条 operator 路由；权限快照只新增这两个确切授权，旧快照与旧断言不动。phone/link 未放行安装。
- 手机设置页、App 中英文提示、微信 mode 命令：没接入时引导「到电脑上点一下接入」，不显示安装脚本或 Grok HOME 命令。

### 测了哪

全部新增行为先测红再实现。看到过的行为红包括：单家检测误测所有家、晚注册入口缺失、旧 Grok auth 误报成功、超时重检被 guard tick 抹掉、新机 health tick 吞向导、Windows HOME/PATH、自定义 binary/nvm、Grok 安装器查主人 HOME、路径 `$&/$'/反引号` 被 JS replace 展开。对应测试现已绿。Rust 按要求只先写假 launcher 测试、再写实现，没有编译/运行，不能声称 Rust 红绿已跑。

- 28 个牵连单测/守卫文件，`bun run test <下列文件> --maxWorkers=1`：**409 项通过**。
  - lib：`executor-cli-setup.test.ts`、`executor-cli-setup-script.test.ts`、`grok-home.test.ts`、`grok-home-login.test.ts`、`find-codex-binary.test.ts`、`util.test.ts`、`util-setup-binaries.test.ts`。
  - daemon：`cli-setup-receipt.test.ts`、`internal-api/routes-cli-setup.test.ts`、`llm-health.test.ts`、`bootstrap/providers.probe-retry.test.ts`、`bootstrap/wire-model-options.test.ts`、`mode-commands.test.ts`、`guard/{bx,gate,runtime}.test.ts`。
  - desktop：`modules/{cli-setup,dashboard}.test.ts`。
  - scripts：`route-registry`、`client-paths`、`module-lazy`、`routes-snapshot`、`desktop-contracts`、`desktop-ts-check`、`desktop-cli-calls`、`phone-routes`、`daemon-module`、`link-routes-from-source` 的 `.guard.test.ts`。
- `bun run test src/features/phone/settings-panel.test.ts -t 'settings panel — 模型与后端' --maxWorkers=1`：**9 项通过**，其余 63 项有意未选，不启动监听。
- `bunx tsc --noEmit --incremental false`、`bun scripts/gen-routes.ts --check`、`git diff --check` 通过。
- `bun run depcheck`：0 errors，16 条现有 cli→daemon 警告。独立只读评审发现的正确性问题已补测试并修复。
- 曾误选整个 settings-panel 套件：54 项失败，含新增指引断言当时的红，以及 HTTP 监听被沙盒拒绝（如 `HTTP: everything without a valid token is 401; with token the API round-trips`，`Failed to start server`）。没有成功启动监听；已修正为上述不监听的 9 项，完整 HTTP 套件未在本机复验。
- 所有安装器/登录脚本测试只执行临时假 curl/bash/CLI/解释器；未打开真实终端、未安装/登录、未调用真实模型。未运行 cargo、浏览器/模拟器/截图、完整 verify 或真实形状监听沙盒；未动运行中 daemon、生产数据库、应用或主人渠道目录。

### CI / mini / 真机还要验什么

1. CI 编译 Rust 并跑 `cli_setup_tests.rs`（5 项：输入白名单、响应匹配、0700/固定 Terminal 参数、失败清理、Windows 可见 PowerShell 参数）；跑完整牵连验证、其余守卫。Windows 只单测/CI，不做真机。
2. mini 用隔离工作区、假接口/假 CLI 做 UI 与原生闭环：可见终端、安装成功后才登录、失败/取消、0700 与清理、网络拒绝/恢复、5 分钟超时/重检、关闭切卡、新装自动注册、只在 Grok 标免费、手机无安装入口。QA 版应拒绝真实 launcher；测试真正 Terminal 打开时只允许隔离原生测试入口运行固定离线假脚本，不跑官方安装器/模型/微信或真实 daemon。
3. mini 跑 settings-panel 完整 HTTP 用例与真实形状沙盒；主 Mac 不补监听回归。
4. mini 通过后由整合者串行、在既有网络保护主机上验五家真实官方安装与浏览器授权，重点首次安装后不重启即可使用、Grok 仅 CC HOME 有新登录、取消无回执不报成功。先有完整 app 回滚备份再更新日常应用；本任务没有部署。

官方命令核对来源：[Claude 安装](https://code.claude.com/docs/en/setup)、[Claude 登录](https://code.claude.com/docs/en/cli-reference)、[Codex 官方 README](https://github.com/openai/codex)、[Cursor 安装](https://cursor.com/docs/cli/installation)、[Grok Build 免费试用说明](https://x.ai/build)。agy 按主人指示保留官网路径，未加入安装器。
