# CC 桌宠陪伴感 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CC 安静常驻、靠近有回应、单击可交办，同时准确表达真实任务并平滑维持动作。

**Architecture:** 沿用 Tauri、真实状态桥、现有精灵和道具。手势层区分单击与拖动，pet 层提供不排队的注意回应，renderer 为持续工作动作加入休息节奏。测试与构建均在明确列出的隔离 Mini；主机只编辑、签名与受保护部署。

**Tech Stack:** JavaScript/JSDoc、Vitest、Playwright、Tauri/Rust、macOS WebKit、SSH。

**Spec:** `docs/superpowers/specs/2026-11-01-cc-desktop-pet-feel-design.md`

## Global Constraints

- 主人已授权直接实现、Mini 验证、合 dev 和日常部署；不再提问或等待设计确认。
- 原角色、冻结资产、Light/Dark 连接语义、真实任务/权限/未读事实保持准确；不添加第二套后台或模型请求。
- 主机不测试、构建、打开 QA 窗口、移动鼠标、输入键盘、抢焦点或截图；全部验证在 Mini。
- 只修改当前独立工作区 `codex/cc-pet-feel`，起点为最新 `origin/dev` 的 `3fba7813`；root 唯一写入者与整合者，探索/评审只读。
- 原 Home’s Mini 网络不可达。可用的 Homebot’s Mini 是已信任的家族检查机；新隔离环境只放 `/Users/homebot/ci/cc-ui-lab/`，遵守 `/Users/homebot/ci/lock`，不触碰其 relay、其他项目和个人数据。原 Home’s lab 不修改。
- UI/原生测试子进程拒绝外连、空状态、无真实 daemon/账户/插件；公开依赖准备可联网。标准平台全量回归另记正常系统进程权限，不冒充系统强制离线。
- QA 只允许 debug、既定 QA identifier 和精确 Mini 身份对；驱动仅回环4199，production build 永不启用 QA feature、不在 Mini 启动生产包。
- 透明穿透只有独立原生证据才交付；无法证明时维持可恢复的矩形输入，明确记录覆盖边界。

## Review Focus

- 迟到的原生移动、快速双击和取消不能误开聊天或丢失已确认位置。
- 工具排视觉隐藏时不得留下不可见的鼠标拦截按钮，键盘和触摸仍有入口。
- hover 不抢工作/权限，不改变形态、事实道具、未读数，也不在恢复后补演。
- 持续动作休息期间事实仍是 working/thinking，新状态必须即时取消旧帧计时器。
- 次级 Mini 支持不能放开未知主机、生产 identifier、非回环端点或任意 lab 路径。

---

### Task 1: 精确限定的次级 Mini 测试环境

**Files:** `apps/desktop/scripts/macmini-ui-protocol{.mjs,.test.mjs}`、`macmini-ui-remote.mjs`、`macmini-ui.mjs`、`macmini-embedded-ui.mjs`；`apps/desktop/src-tauri/src/qa_webdriver{.rs,_tests.rs}`；`docs/maintainer/macmini-ui-lab.md`。

**Interfaces:** `miniConfiguration(identity)` 返回精确主机的 labHome/root/tool 路径；`assertMiniIdentity(identity)` 仍拒绝任何非列出身份；`sshInvocation(command, target = 'home')` 只接受 home/homebot 两个固定目标，默认保持原目标。

- [ ] 写协议测试：接受精确 Homebot 身份；拒绝交叉用户名/机器名、主机上的用户名、lab越界、生产应用、未知target。
- [ ] 在新 Mini 的空目录准备公开依赖，用未改生产协议运行上述测试，确认新目标用例 RED。
- [ ] 实现精确 allowlist、路径/工具推导、独立执行锁与通用检查锁的拥有权保护；QA Rust 增加同样精确身份对，不增加环境开关旁路。
- [ ] Mini 重跑协议/边界测试 GREEN；检查回环可达、保留外部地址连接 EPERM，记录实际身份与源码。
- [ ] 提交环境支持；设置好只读状态入口。期望：已有Home默认参数不变，Homebot只在显式target下执行。

### Task 2: 单击进入聊天与轻量工具排

**Files:** `apps/desktop/src/companion-drag{.js,.test.ts}`、`companion-window{.js,.html,.css,.test.ts}`、`main-navigation{.js,.test.ts}`。

**Interfaces:** `createCompanionDrag` 新增可选 `onClick: () => void`；仅明确主键release、未跨3点阈值、未取消且未失败时触发一次。角色、Enter/Space与按钮共用 `openConversation()` → `show_main_window({page:'converse'})`。

- [ ] 写测试：单击恰好一次、3点边界算拖动、走远返回仍算拖动、取消/失焦/丢mouseup/右键均不开聊天；保留移动确认和持久化断言。
- [ ] 写真实页面接线测试：键盘可达、不重复按键连开、工具排focus/menu保持、导航白名单允许converse并拒绝未知值。
- [ ] Mini 运行三组 Vitest，确认新行为 RED。
- [ ] 实现单击回调与聊天导航。收起常显工具排，hover/focus-within/open显示；隐藏时pointer-events关闭，触摸保持入口，权限卡不受影响。
- [ ] Mini 同组 GREEN，浏览器验证单击/拖动/键盘/可见性。提交。

### Task 3: 靠近回应与持续动作节奏

**Files:** `apps/desktop/src/pet/pet{.js,.test.ts}`、`pet/renderer/sprite-renderer{.js,.test.ts}`、`companion-window.js`、`companion-status{.js,.test.ts}`。

**Interfaces:** `pet.acknowledgeAttention(): boolean` 仅在可动、无transition、idle/companion且有look帧时响应，成功后冷却12000ms，时钟由`opts.now`注入。`renderer.play(animation,{onEnd?, restMs?})` 为loop回到首帧后插入静态维持；working6000ms、thinking9000ms，单次/转场/权限不用此节奏。

- [ ] 写测试：注意回应成功/冷却/被抑制不排队/销毁无操作/两态不变；真实工作和权限不能被抢。
- [ ] 写renderer时钟测试：跑一轮后首帧维持、下一轮继续；更换动画/减动/暂停/stop取消旧节奏，不触发假的完成。
- [ ] Mini 运行相关测试观察 RED。
- [ ] 实现上述接口与pointerenter/focus接线；状态文字按当前permission > 真实exclamation连接异常 > 真正未读内容 > working/thinking，不把装饰error/done当任务真相。
- [ ] Mini GREEN；实际浏览器检查两态、安静/减动/隐藏恢复、未读不闪、权限优先。提交。

### Task 4: 原生验证、评审与串行部署

**Files:** `apps/desktop/scripts/macmini-embedded-ui.mjs`、`apps/desktop/e2e/*companion*.spec.ts`、本批验证报告；必要时独立原生命中研究文件。

**Interfaces:** 沿既有 QA WebKit 驱动，读取实际 AppKit 位置/尺寸并检查聊天navigate回执。源提交、tree、构建与最终部署包逐一绑定。

- [ ] Mini 增加真实WebKit回归：点击不移窗、拖动只移窗、键盘聊天入口、隐藏工具恢复、注意回应冷却、工作节奏与权限/减动恢复；截图只取QA WebView。
- [ ] 透明区域穿透先用两个所属QA窗口研究。只有实际跨应用/窗口投递证据且恢复可用才纳入；无系统输入授权时记录未覆盖并不更改生产鼠标穿透机制。
- [ ] 在同条件Mini记录空闲/活跃资源摘要；跑affected verify、浏览器、原生QA、完整verify --full。所有通过后提交，生成整个分支diff并由独立评审读取。
- [ ] 修复实质问题，Mini重跑受影响检查；root在自己的集成工作区合入dev，Mini对齐最终提交再跑full与生产无签名构建。
- [ ] 受保护备份当前完整签名应用，传回已验证包并签名；同SHA CI通过后由root串行部署和两条真实自检，失败回滚；不启动或聚焦主机GUI。推送dev并核对远端。
- [ ] 保存全部回执，最后一次性向主人报告实际交付与覆盖边界。master/tag和公开发版不在本批范围。
