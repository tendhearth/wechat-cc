<h1 align="center">Tendhearth CC</h1>

<p align="center">
  <b>住在你自己电脑上的个人 AI。找 CC 说一句话，在桌面、手机和微信里接着做。</b>
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

**Tendhearth CC 是住在你自己电脑上的个人 AI，日常叫它 CC。** 跟它说话、交办事情，需要决定时再回来拍板。

- **此刻**：看看有什么需要你处理，CC 正在做什么。
- **一起做**：交代要求、处理权限和问题、查看成果，继续同一件事。
- **回忆**：收好过去的片段；陪伴记忆与工作任务上下文分开。

任务保留各自的对话和成果，同目录的冲突任务排队。不同执行者的权限与接续能力见[工作台能力说明](docs/cc-workbench.md)。

**手机入口：** [原生 Expo app](apps/app/README.md)和[浏览器/PWA](apps/mobile/README.md)。本页描述 dev；真机验收与手机公开发布另有交付状态。

记录保存在本机；执行所需材料会发送给你配置的 AI 服务。命令仍叫 `wechat-cc`，包名仍为 `claude-channel-wechat`，见[产品命名规范](docs/reference/product-naming.md)。

<p align="center">
  <img alt="桌面会话详情，使用演示数据" src="docs/screenshots/chat-detail.png" width="380">
</p>
<p align="center"><sub>桌面会话详情 · 演示数据</sub></p>

---

## 两条安装路径

| | **桌面安装器** (推荐) | **终端** (开发者) |
|---|---|---|
| 适合谁 | 任何人，包括非技术 | 你 OK 装 bun + git |
| 拿到什么 | 4 步向导（环境检查 → 选 agent → 扫码 → 装服务）+ dashboard：绑定账号 / 记忆 / 会话 / 日志 / 一键升级 | 同样的 daemon，没有 GUI |
| 怎么走 | 从 [最新 release](https://github.com/tendhearth/wechat-cc/releases/latest) 下 bundle | `git clone` + `bun install` + `wechat-cc setup` |
| 运行环境 | 核心运行环境已内置，无需另装 Bun 或克隆源码。macOS 支持 Apple Silicon，1.7.1 已签名、公证；所选外部执行者仍需安装和授权 | 安装 Bun、Git 与所选外部执行者 |

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
| **多项目切换** | 一个 bot 管多个仓库(桌面上登记文件夹,或说「切到 <alias>」) |
| **多 agent** | `/cc` `/codex` `/cursor` `/api` `/agy` `/both` `/chat`——几家大脑在同一个对话里,还能开一场匿名辩论 |
| **Companion** | 会反过来找你的 Claude;记忆存在 daemon 里,换哪家大脑都不丢 |
| **双面镜子** | dashboard:你做过什么,以及 CC 注意到了什么 |
| **Hearth 集成** | 在手机上做 markdown 笔记库的治理 |
| **语音回复** | 出站语音走你自己的网关 |
| **CLI 兜底** | bot 能做的,终端里都能做 |
| **你自己的终端会话进微信** | `wechat-cc hook` 把本机 claude / codex 会话的结果推到微信,还能在微信里拍板 |

聊天之外还有**桌面工作台**——把一个文件夹交给执行者,看它的改动、权限卡和等待行:[docs/cc-workbench.md](docs/cc-workbench.md)。

## 它怎么工作

桌面、微信与手机连接你电脑上的常驻后台。后台保存记忆和任务记录，再调用你配置的对话后端或任务执行者。

实现细节见[系统架构](docs/architecture.md)、[模型与后端](docs/reference/model-management.md)和[内部 API 鉴权](docs/reference/internal-api-auth.md)。

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
| `/help` `/帮助` · `/whoami` | 按你的档位列命令 · 你是谁 + 当前模式 |
| `/cc` `/codex` `/cursor` `/api` `/agy` · `/both` · `/chat` | 哪家大脑回答,或全部一起 |
| `/set` | 图形设置面板(不用背命令) |
| `/health` · `/reset` | 大脑通不通 · 本对话从头来 (admin) |
| `任务 …` | 手机上管工作台任务(见 [docs/cc-workbench.md](docs/cc-workbench.md)) |
| `让<名字><任务>` / `派<名字><任务>` | 把任务派给已配对的手 (admin,见[功能 9](#9--一个大脑多手人在公司让家里电脑干活)) |

Companion + 记忆相关用自然语言配置（`开启 companion` / `切到陪伴` / `别烦我` 等），不是 slash 命令。记忆：说 `整理记忆` 让 CC 重新整理对你的理解，说 `看记忆` / `你对我的理解` 看它目前怎么理解你（admin）。

**自检 & 自愈（admin）。** 感觉不对劲就直接问 bot——「你怎么不回消息了，检查下」「这个 chat 为什么不回，修一下」。它能查自己每一回合的结局（上一回合是超时？出错？）、看哪些 agent 会话还活着或卡住、检查 daemon 健康，然后动手修：释放卡住的会话（下一条消息重开一个干净子进程）、切换模型、或重启 daemon——每个动作都会回读确认。这些工具**仅限 admin**，非 admin 的 chat 根本不会注册。用这种方式切模型下一回合就生效，不用重启 daemon。

---


完整清单(含 `/set …`、`/hearth`、`自改`、让<名字>执行):**[docs/reference/wechat-commands.md](docs/reference/wechat-commands.md)**。

## 升级

```bash
wechat-cc update             # pull + 重装依赖 + 重启服务
wechat-cc update --check     # 仅探测，无副作用
```

桌面 GUI 启动时调 `--check` 决定要不要高亮「立即升级」。

如果 daemon 是服务跑的（LaunchAgent / systemd / 任务计划），`update` 自动 stop → pull → 必要时 `bun install` → 重启。如果你 `wechat-cc run` 在前台跑，命令拒绝（`daemon_running_not_service`）不会杀掉你的 shell——先 Ctrl+C 再升级。

---

## 运行时目录

状态默认保存在 `~/.claude/channels/wechat/`，不写入源码仓库。配置、凭据、日志与记忆的逐文件说明见[运行时目录](docs/reference/state-layout.md)。

---

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


三档权限各自能碰什么、v1 的已知限制(把敏感层级交给它之前该先读)、以及 `access list|remove`(加人走管理员聊天流程):**[docs/reference/access-control.md](docs/reference/access-control.md)**(英文)。

## Demo 数据（截图 / 第一印象用）

用 `wechat-cc demo seed` 填入演示记录，`wechat-cc demo unseed` 撤销。指定对话与其他选项见[演示数据说明](docs/reference/demo-data.md)。

---

## 已知限制

- **首次联系** —— 对方没先发过消息，你联系不了（ilink 需要他的 `context_token`）
- **不支持群聊** —— ilink 1:1 only
- **macOS Intel 桌面 bundle** —— 暂不提供。走终端路径
- **安装安全提示** —— macOS 1.7.1 已签名、公证；Windows 首次启动仍可能出现 SmartScreen。见[发布记录](https://github.com/tendhearth/wechat-cc/releases/tag/desktop-v1.7.1)。
- **daemon 重启后对话不续** —— 微信记录在你手机上，但 Claude 不会重放它。per-project session resume 让**当前**会话保持温的，不会重建之前的

---

## 常见问题

安装后找不到命令、Windows 日志乱码、升级失败或 bot 不回复时，按[排障指南](docs/reference/troubleshooting.md)处理。维护者的部署、自检和 CI 流程见[维护者手册](docs/maintainer/README.md)。

---

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

出门后继续电脑上的任务、从手机查看成果，或请 CC 回忆对话里的事情。完整场景见[功能说明](docs/reference/features.md)。

---

## 版本

- **源码版本：** 见 [CLI/daemon package](package.json) 与[桌面打包配置](apps/desktop/src-tauri/tauri.conf.json)。本批不修改版本号，也不发布安装包。
- **安装包与发布状态：** 见 [GitHub Releases](https://github.com/tendhearth/wechat-cc/releases)。上文 dev 工作台能力可能新于最新安装包。
- **版本记录：** [docs/releases](docs/releases/)；[下一版桌面草稿](docs/releases/desktop-v1.7.0.md)不是发布公告。
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
