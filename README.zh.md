<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>陪你生活，也陪你做事。用一个 CC 管理 Claude、Codex 和 API 模型，桌面与微信接着做。</b>
</p>

<p align="center">
  <a href="https://github.com/tendhearth/wechat-cc/releases"><img alt="latest release" src="https://img.shields.io/github/v/release/tendhearth/wechat-cc?display_name=tag"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/tendhearth/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tendhearth/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <sub>文档:<a href="./docs/INDEX.md">索引</a> · <a href="./docs/roadmap.md">roadmap</a> · <a href="./docs/architecture.md">架构</a> · <a href="./docs/maintainer/README.md">维护者手册</a></sub>
</p>

---

## 这是什么

**CC 是一个有陪伴感的 AI，也是管理多种执行者的统一工作入口。** 它把 Claude Code、Codex 和已配置的 API 模型接到同一个桌面工作台；离开电脑后，可以从微信继续同一件事。

- **此刻**：看看 CC 正在做什么，留一点安静相处的空间。
- **一起做**：交代任务、补充要求、处理权限和问题，查看完整对话与成果，不用来回打开多个 agent 窗口。
- **回忆**：收好过去的片段、画作、日记和明信片。陪伴记忆与工作任务上下文分开。

多个项目保留各自的任务、草稿、对话和成果；同目录的冲突任务排队。需要另一位执行者检查时，明确交接选定的上下文和成果版本，再把意见交回原任务。微信也能在已知项目里新建任务、补充要求、处理请求、订阅提醒和获取保存的成果。

**当前边界：** Claude/Codex 走专用原生适配器；API 任务执行者用于文字/图片材料与新的文本成果，工具范围更小。已有 Cursor/agy 聊天接入，目前还不能当作受管工作执行者。这里不承诺完整覆盖各家 CLI/App，也不把本机会话恢复称为跨电脑接管。

> 以上描述的是 **dev 分支当前能力**，不是已经发布的新安装包。先看[工作台使用与能力边界](docs/cc-workbench.md)、[对标项目与原始来源](docs/research/2026-09-14-cc-agent-workbench-references.md)、[本批交付记录](docs/superpowers/reports/2026-09-14-cc-workbench-wrapup.md)。

任务记录保存在本机；执行所需材料会发送给你选择的 AI 服务。本地保存不代表模型在本地运行。

<p align="center">
  <img alt="dashboard sessions detail — WeChat-replica chat in iPhone 17 Pro frame, with file + image + quote-reply" src="docs/screenshots/chat-detail.png" width="380">
</p>
<p align="center"><sub>桌面 dashboard · 会话详情。每段微信 × Claude 对话回到 1:1 iPhone 复刻里看——文本、图片、文件、引用回复都在。<i>(示意图，非真实对话)</i></sub></p>

---

## 两条安装路径

| | **桌面安装器** (推荐) | **终端** (开发者) |
|---|---|---|
| 适合谁 | 任何人，包括非技术 | 你 OK 装 bun + git |
| 拿到什么 | 4 步向导（环境检查 → 选 agent → 扫码 → 装服务）+ dashboard：绑定账号 / 记忆 / 会话 / 日志 / 一键升级 | 同样的 daemon，没有 GUI |
| 怎么走 | 从 [最新 release](https://github.com/tendhearth/wechat-cc/releases/latest) 下 bundle | `git clone` + `bun install` + `wechat-cc setup` |
| 注意点 | bundle 没签名（Apple Dev ID + Windows EV 证书未配齐）—— 第一次开需要绕一次 OS 警告。Intel Mac 暂不支持（仅 Apple Silicon）。桌面 app 是个壳，调底层的 source-mode CLI，所以源码也得装一份（或设 `WECHAT_CC_ROOT`）| Bun 跑得起来的地方都行 |

大多数人：抓桌面 bundle。下面是终端路径。

![Wizard environment-check step — red rows show inline fix commands with copy buttons; hard-severity reds (Claude Code missing) get a left bar so the eye lands on the actually-blocking item first](docs/screenshots/wizard-doctor.png)

> 装时少了 Claude Code、微信账号没绑——每行都告诉你怎么修，复制即用。Hard 级（agent backend 缺）的红有左竖条，因为它会让 daemon 起来后空跑；soft 级（账号没绑）随后再补也不影响装服务。

---

## 快速开始（终端）

**前置：** [Git](https://git-scm.com)、[Bun](https://bun.sh) 1.1+、[Claude Code CLI](https://github.com/anthropics/claude-code)。

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash    # 没装 bun 时
git clone https://github.com/tendhearth/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup       # 手机微信扫码
wechat-cc run         # 启动 daemon
```

```powershell
# Windows
irm bun.sh/install.ps1 | iex                # 没装 bun 时
winget install Git.Git                       # 没装 git 时
# 装完 bun / git 必须重开终端，PATH 才生效。
git clone https://github.com/tendhearth/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install ; bun link
wechat-cc setup ; wechat-cc run
```

搞定。手机微信发条消息——电脑上的 Claude 看到，回到聊天里。

> 一次扫码绑一个 1:1 bot。ilink 不支持群聊。扫码的人自动加白名单，其他人默认拒。

<details>
<summary><b>桌面 bundle 快速开始</b></summary>

从 [最新 release](https://github.com/tendhearth/wechat-cc/releases/latest) 下你平台的包：

| 平台 | 文件 | 第一次开 |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` | 拖进 Applications，双击被拦后：**系统设置 → 隐私与安全性 → 仍要打开**（一次）|
| **Windows (x64)** | `.exe` (NSIS) 或 `.msi` | SmartScreen → **更多信息** → **仍要运行** |
| **Linux (x64)** | `.deb` / `.rpm` | 没警告 |

桌面 app 调用底层 `wechat-cc` CLI，所以源码也得放一份：

```bash
git clone https://github.com/tendhearth/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

或环境变量 `WECHAT_CC_ROOT=/your/path`。

然后启动桌面 app——向导带你过环境检查 / 选 agent (Claude 或 Codex) / 扫码 / 装后台服务。完成后进 dashboard。

</details>

---

## 功能

十件事。**带截图和例子的完整版:[docs/reference/features.md](docs/reference/features.md)(英文)。**

| | |
|---|---|
| **双向聊** | 微信进,电脑上的 Claude Code / Codex / Cursor 出——agent 跑在你自己的机器、你自己的仓库里 |
| **`share_page`** | 长内容变成一个网页,手机上也读得下去 |
| **多项目切换** | 一个 bot 管多个仓库(`/project add|list|switch`) |
| **多 agent** | `/cc` `/codex` `/both` `/chat`——Claude 与 Codex 在同一个对话里,还能开一场匿名辩论 |
| **Companion** | 会反过来找你的 Claude;记忆存在 daemon 里,换哪家大脑都不丢 |
| **双面镜子** | dashboard:你做过什么,以及 CC 注意到了什么 |
| **Hearth 集成** | 在手机上做 markdown 笔记库的治理 |
| **语音回复** | 出站语音走你自己的网关 |
| **CLI 兜底** | bot 能做的,终端里都能做 |
| **你自己的终端会话进微信** | `wechat-cc hook` 把本机 claude / codex 会话的结果推到微信,还能在微信里拍板 |

聊天之外还有**桌面工作台**——把一个文件夹交给执行者,看它的改动、权限卡和等待行:[docs/cc-workbench.md](docs/cc-workbench.md)。

## 它怎么工作

```
[你的手机]                       [你的电脑]
   微信 ──────────► ilink ──► wechat-cc daemon ──► Claude Agent SDK ──► Claude
       │            (long-poll)        │                                    │
       ▼                                ▼                                    │
   share_page ◄── cloudflared ◄── Bun.serve(本地) ◄────── reply 工具 ◄──────┘
```

- **接收**：每账号 long-poll `POST /ilink/bot/getupdates`
- **发送**：`POST /ilink/bot/sendmessage`，要用户的 `context_token`（对方必须先发过消息）
- **驱动**：`@anthropic-ai/claude-agent-sdk` 0.2.116 锁定。daemon 自己管 claude 子进程，不再注册成 Claude Code MCP channel
- **状态**：全部在 `~/.claude/channels/wechat/`（见 [运行时目录](#运行时目录)）
- **Companion**：两个 scheduler（push + introspect），不同节奏；introspect / 摘要走隔离 SDK eval，prompt 风格不污染项目对话

---

## 权限模式

**严格 (默认)** —— `wechat-cc run` —— 每次工具调用在微信问你（回 `y abc12` 放行 / `n abc12` 拒绝，10 分钟超时）。和权限中继设计一致。

**绕过** —— `wechat-cc run --dangerously` —— Claude 跑工具不再问。等于 `claude --dangerously-skip-permissions`。Claude 受过训练，真有破坏性的操作会用自然语言先和你确认。**只在你独占的 daemon 上用**。

> ⚠️ 通过 `access.json.allowFrom[]` 给别人共享 bot 时，**不要**开 `--dangerously`——任何被允许的 chat 都会拿到绕过。共享场景请用严格模式。

---


各家 provider 的差别(Claude 每个工具都转发、Codex 走自己的 `approval_policy`、派发出去的回合又不一样)是一张表:**[docs/reference/permission-modes.md](docs/reference/permission-modes.md)**(英文)。

## 微信端命令

| 命令 | 效果 |
|:---|:---|
| `/help` | 帮助 |
| `/status` | 连接状态 + 版本 + 升级探测 |
| `/ping` | 连通性测试 |
| `/users` | 在线用户 |
| `/project add <路径> <别名>` | 注册项目 (admin) |
| `/project list` | 列项目 |
| `/project switch <别名>` | 切项目 (admin) |
| `/project status` | 当前项目 + cwd |
| `/project remove <别名>` | 取消注册 (admin) |
| `@all <消息>` | 群发 |
| `@<名字> <消息>` | 私发给指定人 |
| `/health` | bot 健康 (admin)——列过期 bot + 清理建议 |
| `/hearth ingest｜list｜show｜apply` | vault 治理 (admin，hearth 启用后) |
| `让<名字>执行 <任务>` / `派<名字>跑 <任务>` | 把任务派给已配对的手 (admin，见[功能 9](#9--一个大脑多手人在公司让家里电脑干活))；名字不对会回已配对列表 |

Companion + 记忆相关用自然语言配置（`开启 companion` / `切到陪伴` / `别烦我` 等），不是 slash 命令。记忆：说 `整理记忆` 让 CC 重新整理对你的理解，说 `看记忆` / `你对我的理解` 看它目前怎么理解你（admin）。

**自检 & 自愈（admin）。** 感觉不对劲就直接问 bot——「你怎么不回消息了，检查下」「这个 chat 为什么不回，修一下」。它能查自己每一回合的结局（上一回合是超时？出错？）、看哪些 agent 会话还活着或卡住、检查 daemon 健康，然后动手修：释放卡住的会话（下一条消息重开一个干净子进程）、切换模型、或重启 daemon——每个动作都会回读确认。这些工具**仅限 admin**，非 admin 的 chat 根本不会注册。用这种方式切模型下一回合就生效，不用重启 daemon。

---


完整清单(含 `@all`、`/users`、`/hearth`、让<name>执行):**[docs/reference/wechat-commands.md](docs/reference/wechat-commands.md)**(英文)。

## 升级

```bash
wechat-cc update             # pull + 重装依赖 + 重启服务
wechat-cc update --check     # 仅探测，无副作用
```

桌面 GUI 启动时调 `--check` 决定要不要高亮「立即升级」。

如果 daemon 是服务跑的（LaunchAgent / systemd / 任务计划），`update` 自动 stop → pull → 必要时 `bun install` → 重启。如果你 `wechat-cc run` 在前台跑，命令拒绝（`daemon_running_not_service`）不会杀掉你的 shell——先 Ctrl+C 再升级。

---

## 运行时目录

```
~/.claude/channels/wechat/
├── access.json            # 白名单
├── context_tokens.json    # ilink context tokens (一 chat 一条)
├── user_names.json        # chat_id → 显示名
├── sessions.json          # 项目别名 → { session_id, last_used_at, summary? }
├── session-state.json     # bot 健康 (errcode 跟踪)
├── channel.log            # 滚动日志 (10MB rotate)
├── server.pid             # 单实例锁
├── docs/                  # share_page 内容 (7 天 TTL)
├── bin/cloudflared        # 自动下载 (Windows 是 .exe)
├── inbox/                 # 收到的媒体 (30 天 TTL)
├── accounts/<bot_id>/     # 每账号凭据
├── companion/
│   └── config.json        # enabled / snooze / default_chat_id / last_introspect_at
└── memory/<chat_id>/      # per-chat 内容
    ├── profile.md         # 用户面的 markdown，可编辑
    ├── observations.jsonl # Claude 最近观察 (TTL 30 天)
    ├── milestones.jsonl   # 100 条 / 连续聊 等 (永久 + id 去重)
    ├── events.jsonl       # cron 决策 (push/skip/failed/observation/milestone)
    └── activity.jsonl     # 每日 UTC date + 消息计数 (streak detector 用)
```

所有状态都在 `~/.claude/`，不进 repo。

---


逐个文件的地图:**[docs/reference/state-layout.md](docs/reference/state-layout.md)**(英文)。

## 访问控制

默认仅白名单。在**终端**管，不在微信端（防 prompt injection）：

```
/wechat:access                        # 查看策略 + 白名单
/wechat:access allow <user_id>        # 添加
/wechat:access remove <user_id>       # 移除
```

`wechat-cc setup` 扫码人自动加入白名单。

微信内「允许/拒绝 &lt;码&gt;」与「邀请码」为新增路径(仅 allowFrom;
admins/trusted 仍仅终端管理)——陌生人首条消息会收到中性回复,你(admin
chat)收到带 6 位码的通知,回码即批准/拒绝;或主动发「邀请码」给朋友一次性口令。
想要完全隐身(不回复、不通知、什么都不做)?把 `access.json` 的
`dmPolicy` 设为 `"disabled"`。

---

## A2A 整合(P3,可选)

别的 agent(或者你自己的另一台机器)可以给这个 bot 发通知,它也能把任务派回去——一个大脑,多只手。HTTP 服务**默认关**(`agent-config.json:a2a_listen`),`a2a_send` 和别的工具一样按用户层级管。

怎么开、CLI 子命令、以及「人在公司让家里电脑干活」的完整走法:**[docs/reference/a2a.md](docs/reference/a2a.md)**(英文)。


三档权限各自能碰什么、v1 的已知限制(把敏感层级交给它之前该先读)、以及 `access list|add|remove`:**[docs/reference/access-control.md](docs/reference/access-control.md)**(英文)。

## Demo 数据（截图 / 第一印象用）

新装一片空——记忆 0 / 观察 0。要预览 dashboard 完整形态：

```bash
wechat-cc demo seed                   # 3 条观察 + 1 个里程碑 + 5 条事件
wechat-cc demo unseed                 # 撤销
wechat-cc demo seed --chat-id <id>    # 指定 chat 而非默认
```

稳定 id 前缀（`obs_demo_*` / `ms_demo_*`）保证 unseed 干净。

---


**[docs/reference/demo-data.md](docs/reference/demo-data.md)**(英文)。

## 已知限制

- **首次联系** —— 对方没先发过消息，你联系不了（ilink 需要他的 `context_token`）
- **不支持群聊** —— ilink 1:1 only
- **macOS Intel 桌面 bundle** —— 暂不提供。走终端路径
- **桌面 bundle 未签名** —— 第一次开需要绕一次 Gatekeeper / SmartScreen
- **daemon 重启后对话不续** —— 微信记录在你手机上，但 Claude 不会重放它。per-project session resume 让**当前**会话保持温的，不会重建之前的

---

## 常见问题

**`bun` / `git` / `wechat-cc` 找不到**
重开终端。`bun link` 或新装 Bun / Git 后，PATH 在当前 shell 不会自动刷新。

**Windows 上读日志中文乱码**
PowerShell 默认 ANSI（GBK）读文件。用：
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**首次 `share_page` 弹防火墙**
v1.0 已修，`docs.ts` 绑 `127.0.0.1`。旧版本 `wechat-cc update` 升级后解决。

**`wechat-cc update` 报 "git not found"**
`update` 会 `git pull`，确认 Git 在 PATH。Windows: `winget install Git.Git`，重开终端。

**Bot 不回了 (errcode=-14)**
微信里跑 `/health` (admin)。过期 bot 列在那里，回 `清理 <bot-id>` 移除。重新扫码绑新 session。

---


每条对应的修法:**[docs/reference/troubleshooting.md](docs/reference/troubleshooting.md)**(英文)。维护者那一侧的回路(部署 / 自检 / CI)见 [docs/maintainer/README.md](docs/maintainer/README.md)。

## 卸载

```bash
# Linux / macOS
rm -rf ~/.claude/plugins/local/wechat   # 删插件源码
rm -rf ~/.claude/channels/wechat        # 清所有状态
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force
```

用了桌面 bundle 的话，记得把 app 拖废纸篓 / 系统包管理卸载。

---

## 用例

- **出门有长任务在跑** —— 电脑上启 deploy / 重构，锁屏出门，从手机继续推
- **把 Claude 写的 plan 转给老板** —— `share_page` 给的 URL + Approve 按钮，非技术人不用读对话
- **多人协作** —— `access.json.allowFrom[]` 共享 bot，每人的消息都路由到你这一个 Claude
- **会记得你的 Claude** —— Companion + 记忆 pane 慢慢长出一份关于你的小画像。你能读它，纠正它，archive 不想被记住的事

---

## 版本

- **源码版本：** 见 [CLI/daemon package](package.json) 与[桌面打包配置](apps/desktop/src-tauri/tauri.conf.json)。本批不修改版本号，也不发布安装包。
- **安装包与发布状态：** 见 [GitHub Releases](https://github.com/tendhearth/wechat-cc/releases)。上文 dev 工作台能力可能新于最新安装包。
- **版本记录：** [docs/releases](docs/releases/)；[下一版桌面草稿](docs/releases/desktop-v1.6.7.md)不是发布公告。
- **当前架构与交付证据：** [架构说明](docs/architecture.md)、[工作台导览](docs/cc-workbench.md)。

---

## 参与贡献

Issues + PRs 欢迎： [github.com/tendhearth/wechat-cc](https://github.com/tendhearth/wechat-cc/issues)。

```bash
bun install
bun --bun vitest run    # 完整测试套件
bun run typecheck      # 类型检查
```

`apps/desktop/` 是 Tauri 2 GUI。四个模式共用同一个 dev server（[`apps/desktop/test-shim.ts`](./apps/desktop/test-shim.ts)），都带热重载：

- `bun run dev` —— 真 Tauri 壳（会自动起 dev server）
- `bun run dev:web` —— 普通浏览器直连真 CLI + 真 daemon
- `bun run dev:mock` —— mock 状态，Playwright 用的就是这个
- `bun run dev:unsafe` —— 同 `dev:web`，但关掉安全阀

三个浏览器模式下，dev server 只转发已知只读的 CLI 命令；会改真实状态的一律拒绝并给出提示（`dev:unsafe` 关掉这层，横幅变红）。`bun run dev` 是真应用，invoke 走 Rust IPC，**不受安全阀保护**。

---

## 免责声明

本插件是**非官方的社区项目**，与腾讯、微信无任何关联。

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
