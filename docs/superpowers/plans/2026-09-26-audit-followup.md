# 2026-09-26 梳理后续(文档校正 / 守卫测试 / 删退役 / 补文档)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-09-26 全仓梳理报告里「建议顺序」第 2–5 步落地:三份总图与 README 说实话、三条守卫测试把最贵的登记税钉死、删掉退役未删的代码与脚本、补三份缺席文档。不动架构(第 6、7 步另出设计稿)。

**Architecture:** 纯加法与纯删法:守卫测试全部放 `scripts/*.guard.test.ts`(仓库既有模式,只在 bun 套件跑);文档改动只改「现状」文档,不改 spec;删除只删 0 引用的东西,每删一处先跑引用 grep。gemini 标 deprecated 不删。

**Tech Stack:** Bun 1.3.14 / vitest 4 / TypeScript;文档为 Markdown;`scripts/build-map.ts` 生成导图 HTML。

**Spec:** 梳理报告 `/private/tmp/claude-501/-Users-nategu-mac-company-Documents-tendhearth-wechat-cc/d42cddd7-2797-4834-8354-8a04e3c5555f/scratchpad/wechat-cc-梳理报告-2026-09-26.md`(会话外部文件;本计划把要用到的事实都抄在任务里,不依赖它)。主人拍板(2026-09-27):发版 tag 已推;STT 口径 = 「已做,网关形态,配置门控」;gemini = 标 deprecated 保留;本轮做完第 2–5 步停。

## Global Constraints

- 分支 `sweep/2026-09-26-audit-followup`(从 `origin/dev` e070837c 起),工作树 `.claude/worktrees/audit-followup`。**不碰 `dev` / `master` / 兄弟工作树**;做完推分支,由整合者合入 dev。
- 每个任务一个 commit,commit message 中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 四道本地闸门在最后一次性跑:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`。单个任务只跑相关文件。
- 基线:`bun run test` 8793 过 / 1 红(红的那条在 Task 0 记下,若是已知 flake 不算本分支的账)。
- 删除任何文件前,先 `grep -rn "<basename>" src apps scripts package.json .github docs/maintainer docs/INDEX.md README.md` 确认 0 引用(docs/superpowers 与 docs/releases 是历史记录,引用不算)。
- 文档写「现状」用陈述句,带日期;不改 `docs/superpowers/specs/*`(设计依据不随代码更新)。
- `docs/全景导图.html` 永不手改,改完 md 跑 `bun scripts/build-map.ts`。

## Review Focus

1. **路由守卫误报**:`lib.rs` 的 `matches!` 里带注释行;正则必须只抓 `("GET", "/v1/…")` 形状,漏抓比误抓危险(漏抓 = 守卫沉默)。Task 9 的测试先断言抓到的条数 ≥ 34。
2. **删 sessions.js 死路径时误删活函数**:`dialogue-page.js` 通过 `import { … } from './sessions.js'` 用了 6 个导出,`settings-drawer` 用 `deleteProjectByAlias`。Task 13 先跑引用 grep 生成 keep 表,再删。
3. **删 customer-review 时把 待办 的 Rust 代理一起删了**:`customer_review_api` 同时服务 `OWNER_WORKSPACE_PATHS`(待办)。Task 14 **保留** Rust 命令与 `callOwnerWorkspace`,只删 `/v1/customer-review` 前缀分支与前端模块。
4. **Cargo.lock 手改**:只改 `name = "wechat_cc_desktop"` 那个 package 的 `version`,别动其它包。Task 12 用 `grep -n -A1 'name = "wechat_cc_desktop"'` 定位。
5. **导图 HTML 与 MD 不同步**:Task 6 改完 md 必须重跑 build-map 并 `git diff --stat` 看到 html 变了。

---

### Task 0: 记基线

**Files:** 无改动。

- [ ] **Step 1:** 从基线输出里找红的那条:`grep -n -B3 -A12 processTicksAndRejections <baseline-output>`。若是 `Test timed out` 且文件在 `src/cli/ci-flakes.json` 登记过 ⇒ flake,记在本计划末尾「执行记录」;否则单跑一次 `bun --bun vitest run <file>`,仍红 ⇒ 停下报告,不继续。

---

### Task 1: 新文档 `docs/maintainer/release.md`(发版管线)

**Files:**
- Create: `docs/maintainer/release.md`
- Modify: `docs/maintainer/README.md`(索引表加一行)

**Interfaces:** Produces 路径 `docs/maintainer/release.md`,Task 5 / Task 7 会链接它。

- [ ] **Step 1: 写 release.md。** 内容(全部来自 `.github/workflows/{mirror-desktop-tag,desktop,publish-update}.yml` 头注释与 `scripts/publish-update.ts` 头注释,已核):

```markdown
# 发版(桌面 + 自动更新源)

> 2026-09-27 首版。此前整条链只写在三个 workflow 的头注释里,`roadmap` 把「发版管线」链到 `deploy.md`(那页讲的是本机换 sidecar)。

`self deploy`(deploy.md)是**本机**换 sidecar;这页是**给用户**发版。两者共用同一个版本号(`scripts/version-consistency.guard.test.ts` 钉住四处 + Cargo.toml)。

## 一次发版要人做的四件事

| # | 人做什么 | 机器接着做什么 |
|---|---|---|
| 1 | 在 dev 上把版本号升到 X.Y.Z(根 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`Cargo.toml`;`bun --bun vitest run scripts/version-consistency.guard.test.ts` 绿),写 `docs/releases/desktop-vX.Y.Z.md`,合进 master(squash PR) | — |
| 2 | 在 master 的发版提交上打 tag 并推:`git tag -a vX.Y.Z <sha> -m "desktop vX.Y.Z" && git push origin vX.Y.Z` | `mirror-desktop-tag.yml` 用 `RELEASE_PAT_WECHAT_CC` 把它镜像成 `desktop-vX.Y.Z`(GITHUB_TOKEN 推的 tag 不会触发下游,这是 v0.5.17 踩过的坑) |
| 3 | 到 Actions 里给 `Desktop Build` 的 `release-signing` 环境点**批准**(签名私钥挂在这个环境上,每次构建都要点) | `desktop.yml` 三平台构建(linux-x86_64 / macos-aarch64 / windows-x86_64;macOS Intel 跳过)→ 建 **Draft** Release 并挂产物 |
| 4 | 在 Releases 页检查 Draft(产物齐、说明对),点 **Publish**;随后再给 `Publish Update Channel` 的 `release-signing` 点一次批准 | `publish-update.yml` 用 release 自己的资产跑 `scripts/publish-update.ts --from-dir … --no-github`,生成 `latest.json` 上传 R2(`dl.tendhearth.com/wechat-cc/latest.json`;只发 darwin-aarch64 + windows-x86_64;每平台留 3 版)。老用户的 Tauri updater 从此看到新版 |

补发(某次 R2 令牌过期):Actions → `Publish Update Channel` → Run workflow,填 `desktop-vX.Y.Z`。

## 两道人工批准是有意的

签名私钥 = 让所有已安装 app 自动下载并运行任意代码的钥匙;R2 令牌 = 决定所有已安装 app 该装哪个版本。都挂在带必需审批人的 `release-signing` 环境上,每次取用留痕。**不要自动化掉。**

## 已知坑

- `wechat-cc update` **不读** `v*` tag,它比的是 `origin/<branch>`(`src/cli/update.ts`);`v*` tag 唯一的作用是被镜像成 `desktop-v*`。
- Windows 只在 CI 编译;签名与发布固定在 Mac / CI(Win32 给环境变量赋空串等于删除,tauri 签名步骤会挂死等密码)。
- `.sig` 是 minisign 签名、平台无关;曾被发版脚本的双层过滤丢掉过(2026-09-03,已修)。
- 产物名与平台映射在 `scripts/publish-update.platforms.ts`,守卫 `scripts/release-pipeline.guard.test.ts`。
```

- [ ] **Step 2:** `docs/maintainer/README.md` 索引表在 `deploy.md` 那行后加:

```markdown
| [release.md](release.md) | 给用户发版:四个人工步骤、两道 `release-signing` 批准、tag 镜像、R2 更新源;和 `self deploy` 的区别 |
```

- [ ] **Step 3: Commit** `docs(maintainer): 发版管线手册页 —— 四个人工步骤与两道批准`

---

### Task 2: 新文档 `docs/reference/internal-api-auth.md`(内部 API 鉴权现状)

**Files:**
- Create: `docs/reference/internal-api-auth.md`

**Interfaces:** Produces 路径,Task 5(INDEX)与 Task 23(rules)链接它。

- [ ] **Step 1: 写文档。** 事实来源:`src/daemon/internal-api/token-registry.ts` 头注释、`route-tiers.ts` 头注释与 `minTierFor`、`src/core/user-tier.ts`、`settings-panel.ts:312-315,444,470,527-531`、`src/lib/runtime/http.ts:37`。结构与要点:

```markdown
# 内部 API 鉴权模型(现状)

> 2026-09-27 首版。此前散在 architecture.md §2.2、maintainer/verify.md、rules-from-real-machines.md 和三份 spec 里,没有一处写「现在是什么样」。代码是唯一事实源:`src/daemon/internal-api/{token-registry,route-tiers,index}.ts`、`src/core/user-tier.ts`。

## 谁在调
daemon 的内部 HTTP API 只监听 127.0.0.1,调用方是:每个 agent 会话的 stdio MCP 子进程(wechat 工具)、桌面 app(经 Tauri 宿主代理)、CLI 子命令、手机页(经 daemon 自己的 `/m/api/*` 分发器,**不走这套鉴权**,见末节)。

## 两道门
1. **tier**:`guest < trusted < admin`(`src/core/user-tier.ts`)。每条路由在 `route-tiers.ts` 的 `ROUTE_MIN_TIER` 里声明最低档;**没登记的路由 ⇒ admin**(`minTierFor`,fail-closed)。`route-tiers.test.ts` 有一条「每条 makeRoutes 的路由都必须登记」。
2. **routeAllow**:token 上可选的路由白名单;有就只许调白名单里的 `"METHOD /path"`,不看 tier。dispatcher 在 tier 之后再查(`index.ts`)。

## 三种 token 来源(`TokenInfo.origin`)
| origin | 谁拿 | tier | routeAllow | 存哪 |
|---|---|---|---|---|
| `file` | 任何能读 `<stateDir>/internal-token` 的本机进程(CLI、trusted agent 的 shell) | 固定 `trusted`(shell 可读的凭据不能高于最不可信的读者) | 无 | 文件 0600,每次 boot 轮换 |
| `session` | 每次 spawn 的 agent 会话,经环境变量 `WECHAT_SESSION_TOKEN` | 该会话的真实 tier(admin 只从这里来) | 无(federation mint 例外:带 TTL + routeAllow) | 只在子进程 env;例外 `agy-static`(agy 只有全局 mcp_config.json,一枚长期 trusted token 落盘 `~/.gemini/config/mcp_config.json`) |
| `operator` | 桌面 app 的 Tauri 宿主(`internal-operator-token`,webview JS 永远拿不到) | `admin` | **有**:converse/speak/transcribe、customer-review、待办五条、pet permission resolve、federation mint、workbench 全套、matters 四条(精确集合见 `token-registry.ts` 与它的测试) | 文件 0600 |

## 新加一条路由要登记几处
- 桌面不调:`routes-*.ts` 写 handler → `route-tiers.ts` 声明 tier(→ 若有请求体校验,`schema.ts`)。
- 桌面会调:再加 `token-registry.ts` routeAllow、`apps/desktop/workbench-proxy.ts` ROUTES、`apps/desktop/src-tauri/src/lib.rs` `workbench_request_allowed` 的 `matches!`。三份必须一致 —— `scripts/route-registry.guard.test.ts` 钉住 `lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER`。漏一处的症状:只在打包版出现 403 `route_not_allowed`。

## 这套鉴权之外的门(要知道)
- **手机设备 token**(`settings-panel.ts`):`/set` 与 `/m` 页用自己的 token 体系 —— 10 分钟短链接 token(`t` 前缀)与长期设备 token(`d` 前缀,落盘 `settings-devices.json`,上限 20 台,永不过期)。它等价主人,不经 token-registry、没有 tier、没有 routeAllow;隧道来的 `set_remote` 被拒(`lan_only`)。面板监听 `0.0.0.0`,局域网链接把短 token 放在 `?t=` 查询串里。**已记为架构待改项**(设备 token 进 token-registry 作 `origin:'device'`,http 默认改 loopback)。
- **admin session token 无 routeAllow**:主人 chat 的 MCP 子进程持有能调 `daemon/restart` 等全部 admin 路由的 token,只靠 LLM 侧的工具分类拦。已知、接受、待改。
- **file token 的 trusted 档约 90 条路由**含 `memory/write`、`plugins/install`、`a2a/send`。
- **wxvault 等插件工具**:未知 `mcp__*` 一律按 `plugin_tool` ⇒ admin-only(`user-tier.ts`)。
```

- [ ] **Step 2: Commit** `docs(reference): 内部 API 鉴权模型现状 —— 两道门、三种 token、登记几处、体系之外的门`

---

### Task 3: 新文档 `docs/reference/model-management.md`(模型与后端管理)

**Files:**
- Create: `docs/reference/model-management.md`

- [ ] **Step 1: 核对事实。** 跑并记下输出:

```bash
grep -n "'/api'\|/api list\|/api alias\|unalias" src/daemon/mode-commands.ts | head
grep -n "SET_USAGE" src/daemon/mode-commands.ts
grep -rn "'model_get'\|'model_set'\|'provider_switch'" src/mcp-servers/wechat/*.ts | grep -v test
grep -n "'GET /v1/model'\|'POST /v1/model'\|set-mode" src/daemon/internal-api/routes*.ts | head
```

- [ ] **Step 2: 写文档。** 依据 `docs/superpowers/specs/2026-09-08-model-management-design.md`(SHIPPED)+ Step 1 输出。结构:

```markdown
# 模型与后端管理(现状)

> 2026-09-27 首版。设计依据 `superpowers/specs/2026-09-08-model-management-design.md`;README 2026-09-22 搬空后这块没有任何现行文档。

## 六家后端
`src/lib/provider-ids.ts`:`claude codex cursor openai gemini agy`。微信里对应 `/cc /codex /cursor /api /gemini /agy`。
| id | 形态 | 计费 | 备注 |
| claude | 进程内 SDK | 订阅(Claude Code 登录) | 工作台执行者 |
| codex | 进程内 SDK / app-server | 订阅或 API key | 工作台执行者 |
| cursor | 常驻 `cursor-agent acp` | 订阅 | 对话侧与工作台都走 ACP;`CURSOR_API_KEY` 的 SDK 路只剩对话侧回落 |
| openai(`/api`) | 自跑循环,任何 OpenAI 兼容端点 | API key(`WECHAT_OPENAI_API_KEY`) | DeepSeek / Kimi / Qwen / 本地;外部 Agent 的官方接入路径 |
| gemini | 自跑循环,`@google/genai` | API key(`GEMINI_API_KEY`) | **deprecated**(2026-09-27):被 agy 取代,保留不删 |
| agy | 外挂 Antigravity CLI | 订阅(Google AI Pro) | 订阅版 Gemini;所有对话共用一把钥匙,guest 不可用 |

## 三个入口
1. **提示词身份行**:每轮系统提示写「你是 <provider>(当前模型 <model>)」,问「你是哪个模型」如实答,零工具。
2. **微信 `/set` 与斜杠**:`/set cheap <provider|auto>`(管理员,后台评估用哪家,热改)、`/set providers a,b|all`(非管理员能用哪些)、`/set provider cc|agy|api|…`(全局默认大脑,改完自动重启);`/api list`(拉网关 `/models`,主人主动触发才拨,60s 缓存)、`/api <别名|模型>`(只对本对话)、`/api alias ds=DeepSeek` / `unalias`。
3. **面板「模型与后端」**(`/set` 图形面板):六家一行(注册/体检缓存/模型/未接入提示)、自配 API 表单(地址/默认模型/key,key 走 `llm-keys.ts`,不进日志)、短名增删、后台评估下拉。面板**绝不主动外呼体检**。

## bot 自己能换
- `model_set`(wechat MCP,`tools-daemon.ts`):同家换版本 → `POST /v1/model`(按 provider,写完释放该家的活会话)。
- `provider_switch`(`tools-mode.ts`):换厂家,只动本对话 → `POST /v1/conversation/set-mode`(quiet)。ToolKind `mode_switch`,trusted+。
- 钉模型按对话存 `conversations.mode_model`(v44),`/api` 不带模型 = 回全局默认。

## 有意不做
`/model` `/use` 新动词;别名跨 provider;面板主动拨号。
```

- [ ] **Step 3: Commit** `docs(reference): 模型与后端管理现状`

---

### Task 4: `docs/reference/wechat-commands.md` 从代码重写

**Files:**
- Modify: `docs/reference/wechat-commands.md`(整文件替换)

- [ ] **Step 1:** 用下面内容替换全文。依据:`src/daemon/mode-commands.ts` `KNOWN_SLASH_COMMANDS`(cc codex cursor api gemini agy set solo mode both parallel chat stop whoami name help)+ `/帮助`、`handleHelp` 文案、`SET_USAGE`;`src/daemon/admin-commands.ts` 的正则常量。

```markdown
# 微信命令(现状)

> 2026-09-27 按代码重写。旧表里的 `/status` `/ping` `/users` `/project *` `@all` `@<name>` 早已不存在(源码 0 命中)。事实源:`src/daemon/mode-commands.ts`(`KNOWN_SLASH_COMMANDS` + `/help` 文案)与 `src/daemon/admin-commands.ts`(正则常量)。`/help`(或 `/帮助`)在聊天里给的就是这份的实时版。

## 所有人(guest 只有身份 / 拆分 / 文件三组)
| 命令 | 效果 |
|---|---|
| `/help` `/帮助` | 按你的档位列出可用命令 |
| `/whoami` | 你的身份 + 当前模式 |
| `/name <昵称>` | 设置 / 改昵称(按对话) |
| `/cc` `/codex` `/cursor` `/api` `/gemini` `/agy` | 单 provider(solo);`/api` = 你配置的 OpenAI 兼容后端;可带模型名(`/cc opus`)按对话钉模型。`/agy` `/cursor` guest 不可用 |
| `/api list` · `/api <别名\|模型>` · `/api alias ds=DeepSeek` · `/api unalias ds` | 看网关模型 / 切(只对本对话)/ 起短名 |
| `/cc + codex` | Claude 主答、Codex 当工具(primary_tool) |
| `/both [p1 p2 …]` `/parallel` | 并行回复(裸 = 全部 provider) |
| `/chat [p1 p2 …]` | 圆桌讨论(chatroom) |
| `/solo` `/stop` `/mode` | 回到默认 / 退出多方模式 / 显示当前模式 |
| `/set split on\|off`(拆分 开\|关) | 回复像真人一样分几条发 |
| `/set care off\|low\|high`(关心 关\|低\|高) | 主动关心档位 |
| `/set stickers on\|off`(表情 开\|关)· `/set hunt on\|off`(打猎 开\|关)· `/set visit on\|off`(串门 开\|关) | 表情包 / 每日打猎 / 串门 |
| `/set` | 图形设置面板链接(手机上点开) |
| 拖图片 / 文件 / 语音 | 直接发即可 |

## 管理员
| 命令 | 效果 |
|---|---|
| `/health` · `/health ai` | bot 健康 / 各 provider 会话状态(零 token) |
| `/reset` `/重置` | 丢掉本对话所有 provider 的会话,下一句从头开 |
| `/update` | 拉代码重装重启(源码模式) |
| `/botname [名字\|跳过]` | 设 / 看 / 清 bot 自称 |
| `/set cheap auto\|claude\|agy\|openai\|…` | 后台评估用哪家 |
| `/set providers claude,openai\|all` | 非管理员对话能用哪些 provider |
| `/set provider cc\|agy\|api\|…` | 全局默认大脑(改完自动重启) |
| `/hearth ingest\|list\|show\|apply\|help` | vault 治理(hearth 启用后) |
| `整理记忆` `/synthesize` · `看记忆` `/overview` `你对我的理解` | 重新整理 / 读回 CC 对你的理解 |
| `清理 <bot-id>` `清理 all-expired` | 清理过期 bot |
| `让<手名><任务>` `派<手名><任务>` `/hands` | 派活给已配对的「手」/ 列出手 |
| 粘一串 `WCCP1…` 配对码,或 `/hand <码>` `/配对 <码>` | 加一台手 |
| `/bag` `背包` `猎物` | 打猎战利品 |
| `自改 <需求>` · `自改 状态\|列表` | 让 CC 自己改自己(五道闸门 + 微信拍板,见 maintainer/self-change.md) |
| 回复权限卡 `y <码>` / `n <码>` | 放行 / 拒绝一次工具调用 |
| `任务 …` | 工作台编号命令,见 [cc-workbench.md](../cc-workbench.md#离开电脑后从微信继续) |

陪伴与记忆用自然语言:`开启陪伴` `别烦我` `切到 <alias>` 等。自检与自愈也是自然语言(「你怎么不回消息了,检查下」),工具 admin-only,daemon 侧按 tier 二次把关。
```

- [ ] **Step 2: Commit** `docs(reference): 微信命令表按代码重写 —— 删不存在的六条,补漏的十几条`

---

### Task 5: `docs/roadmap.md` 现状表与链接

**Files:**
- Modify: `docs/roadmap.md:7-26,41,57,63`

- [ ] **Step 1:** 替换「现状」小节(第 7–19 行)为:

```markdown
## 现状:1.7.0 已合、正在发

| 事实 | 怎么看(别写死数字,每次改这页先跑) |
|---|---|
| 最近一次**公开**发版 | `gh release list --limit 1`(2026-09-27:仍是 `desktop-v1.6.5`,08-31) |
| 1.7.0 | PR #117 已于 2026-09-23 squash 合进 master(`63edf14c`);`v1.7.0` tag 2026-09-27 已推,`desktop-v1.7.0` 三平台构建等 `release-signing` 批准 → Draft → 人点 Publish(步骤见 [maintainer/release.md](maintainer/release.md)) |
| `dev` 领先 master | `git rev-list --count origin/master..origin/dev`(2026-09-27:1537) |

版本号已统一(2026-09-22):四处 + `Cargo.toml` 都是 1.7.0,由 `scripts/version-consistency.guard.test.ts` 钉住;`--version` 带 git 短 sha。发版说明 `docs/releases/desktop-v1.7.0.md`。
```

- [ ] **Step 2:** 「下一步」第 23–24 行改为:

```markdown
1. ~~合 #117~~(2026-09-23 已合)。
2. **发 1.7.0** —— tag 已推;剩 `release-signing` 批准 ×2 + 点 Publish,走 [maintainer/release.md](maintainer/release.md)。
```

- [ ] **Step 3:** 第 63 行 STT 改为:

```markdown
- **STT(语音入站)** —— 已通(2026-09-27 口径):网关形态,`stt-config.json` 指定 whisper 网关(`src/daemon/stt/*`),接在入站链 `mw-transcribe-voice`;未配置即关。出站语音也已通(VoxCPM2)。缺的是本地 STT 与首次配置引导。
```

- [ ] **Step 4:** 「已定未做」加一行(放在「错误通道结构化」前):

```markdown
- **设备 token 进 token-registry、http 默认 loopback**(梳理 2026-09-26 第 6 步)—— 手机页的 token 体系在 tier/routeAllow 之外、永不过期、面板监听 0.0.0.0;要先出设计稿。现状写在 [reference/internal-api-auth.md](reference/internal-api-auth.md)。
- **拆三个大文件**(第 7 步)—— `core/workbench/service.ts`(1622 行闭包,按 20 份 `service-*.test.ts` 的边界抽)、`bootstrap/index.ts`(剩余 8 个关注点进 `wire-*.ts`)、`cli.ts`(按命令族下沉;`scripts/cli-ratchet.guard.test.ts` 先钉住不再增长)。
```

- [ ] **Step 5:** 修订记录加:`- 2026-09-27:现状表改成「命令 + 当日值」;#117 已合、tag 已推;STT 口径定为已做;加第 6/7 步待办。`
- [ ] **Step 6: Commit** `docs(roadmap): 现状表不再写死数字;1.7.0 已合正在发;STT 口径;第 6/7 步入账`

---

### Task 6: `docs/INDEX.md` 计数、指针、状态

**Files:**
- Modify: `docs/INDEX.md`

- [ ] **Step 1:** 主题表改动(逐行):
  - `:23` ACP 权威文档「—」→ `[cc-workbench.md](cc-workbench.md#执行者覆盖)`。
  - `:28` Windows 进程树 → `Windows 进程树清理(**已落地** dev 2026-09-24,报告 superpowers/reports/2026-09-24-windows-process-tree-landing.md)`。
  - `:29` 终端会话 ↔ 微信 权威文档 → `[reference/features.md §10](reference/features.md)`。
  - `:30` 模型与后端管理 → `[reference/model-management.md](reference/model-management.md)`。
  - `:35` provider 权威文档 → `[reference/model-management.md](reference/model-management.md)`。
  - `:39` 引导与访客 → `[reference/access-control.md](reference/access-control.md)`。
  - `:45` STT → `| 入站语音 STT(已通,网关形态,配置门控) | [reference/features.md §8](reference/features.md) | superpowers/specs/2026-07-23-inbound-voice-stt-design.md |`。
  - 新增三行:`| 内部 API 鉴权(tier / token / routeAllow) | [reference/internal-api-auth.md](reference/internal-api-auth.md) | superpowers/specs/2026-06-21-internal-api-tier-authz-design.md |`;`| 发版(tag → 构建 → Publish → R2) | [maintainer/release.md](maintainer/release.md) | — |`;`| 每晚整理记忆 / 记忆视图 | [architecture.md §2.4](architecture.md) | superpowers/specs/2026-09-25-memory-nightly-design.md + 2026-09-26-memory-view-design.md |`;`| 网页设计统一(手机 tokens.css) | [../apps/mobile/README.md](../apps/mobile/README.md) | superpowers/specs/2026-09-26-web-design-unify.md |`。
- [ ] **Step 2:** 「目录都装什么」表:去掉所有括号里的数字(`(120)` `(115)` `(27)` `(7)` `(51)` `(18)` `(22)` `(8)`),改成「数量看 `ls | wc -l`」一句放表头说明;`research/` 与 `handoffs/` 从「历史」行拆出来:`| research/ handoffs/ | 2026-09 工作台的参考项目与交接稿,被 README / architecture / cc-workbench 当现行资料引用 | ✅ 现行(少量) |`;`installer/` 改「🗄 2026-04 的安装器说明,待核」。
- [ ] **Step 3:** 修订记录加 `- 2026-09-27 v2:计数去数字;09-25/26 三份 spec 入表;四个「README 对应章节」改成具体 reference 文件(README 09-22 已搬空);新增鉴权 / 发版 / 模型管理三份现状文档;research/handoffs 改标现行。`
- [ ] **Step 4: Commit** `docs(index): 去数字、补指针、三份新现状文档入表`

---

### Task 7: README.md / README.zh.md 校正

**Files:**
- Modify: `README.md:35,170-178,192-204,225,236`
- Modify: `README.zh.md:35,151,171-192,269`

- [ ] **Step 1 README.md:35** 「Current scope」段替换为:

```markdown
**Current scope:** Claude and Codex use native adapters; Cursor joins through `cursor-agent acp` (commands go through permission cards, in-workspace edits do not); agy joins as an unattended executor after a one-time desktop acknowledgement; the configured API adapter handles text/image materials and new text artifacts with a narrower tool set. The executor table with exact boundaries is in [docs/cc-workbench.md](docs/cc-workbench.md#执行者覆盖). CC does not claim feature parity with every CLI or app, or live-process transfer between computers.
```

- [ ] **Step 2 README.md:168-178**:`Adding a fourth provider (Gemini / your own) is a new file in src/core/` → `Six provider ids are registered today (claude / codex / cursor / openai / gemini / agy; see [docs/reference/model-management.md](docs/reference/model-management.md)). Adding one is a capability-matrix row + a registration in src/daemon/bootstrap/providers.ts — scripts/provider-registry.guard.test.ts lists every enumeration that must agree.`;`22 tools` → `the MCP tools`(删数字);`two schedulers (push + introspect)` → `three schedulers (push / introspect / ingest)`。
- [ ] **Step 3 README.md:192-204** 命令表替换为:

```markdown
| Command | What |
|---|---|
| `/help` · `/whoami` | what you can do here · who you are + current mode |
| `/cc` · `/codex` · `/cursor` · `/api` · `/agy` · `/both` · `/chat` | which agent answers, or all of them |
| `/set` | the graphical settings panel (you don't have to memorise commands) |
| `/health` · `/reset` | is its brain reachable · start the conversation over (admin) |
| `任务 …` | workbench tasks from your phone ([docs/cc-workbench.md](docs/cc-workbench.md)) |

Full list including `/set …`, `/hearth`, `自改`, and 让<name>执行: **[docs/reference/wechat-commands.md](docs/reference/wechat-commands.md)**.
```

- [ ] **Step 4 README.md:225**:`~/.local/state/wechat-cc` 那句 → `Everything lives on your machine, under ` + "`~/.claude/channels/wechat/`" + ` (override with `WECHAT_STATE_DIR`): sessions, memory, access list, keys (0600), plugin data. Nothing is uploaded.`
- [ ] **Step 5 README.md:236**:`access list|add|remove` → `access list|remove` (adding people happens in the admin chat flow)`。
- [ ] **Step 6 README.zh.md** 对应四处:`:35` 「已有 Cursor/agy 聊天接入，目前还不能当作受管工作执行者」→ 「Cursor 经 `cursor-agent acp` 进工作台(命令过权限卡、工作区内编辑不过);agy 桌面确认一次后按免审执行者进;执行者边界表见 [docs/cc-workbench.md](docs/cc-workbench.md#执行者覆盖)」;`:151` 「两个 scheduler(push + introspect)」→「三个 scheduler(push / introspect / ingest)」;`:171-192` 命令表换成 Step 3 的中文版(`/help · /whoami` / provider 六家 / `/set` / `/health · /reset` / `任务 …`,「完整清单(含 `/set …`、`/hearth`、`自改`、让<名字>执行)」);`:269` `access list|add|remove` → `access list|remove`。
- [ ] **Step 7:** `grep -n "/status\|/ping\|/users\|/project \|@all\|local/state\|22 tools\|fourth provider\|access list|add" README.md README.zh.md` 必须为空。
- [ ] **Step 8: Commit** `docs(readme): 产品边界、状态目录、命令表、CLI 三处按代码改正`

---

### Task 8: `docs/architecture.md` 数字改指针 + 三处事实

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** 头部免责声明(`:3-7`)后加一段:

```markdown
> **2026-09-27 修订**:去掉了所有会漂的数字与行号(迁移条数、中间件条数、provider 数、`file.ts:NNN`),改成「看哪个文件」。数字型事实以这些为准:迁移 `src/lib/db.ts` 的 `migrations` 数组(末条注释 `// vNN`);入站链 `src/daemon/inbound/build.ts`;provider 列表 `src/lib/provider-ids.ts`;路由与 tier `src/daemon/internal-api/route-tiers.ts`。
```

- [ ] **Step 2:** 逐处改:
  - `:69` `inbound pipeline (17 mw)` → `inbound pipeline (see inbound/build.ts: route probe → one consume table → dispatch)`;`:131` `17-mw onion pipeline (inbound/build.ts:42, …)` → `onion pipeline (inbound/build.ts; order is load-bearing: access-gate before side-effects, dedup wraps the turn, the read-only intent probe mw-route runs before mw-consume's single consumer table)`。
  - `:106-108` 三个 `agent-provider.ts:NN` 删行号,保留符号名。
  - `:111-117` provider 表加两行:`| agy | **wrap** | Antigravity CLI (subscription Gemini) | CLI | ✅ | ❌ |`、`| cursor (ACP) | **wrap** | cursor-agent acp (stdio JSON-RPC) | CLI | ❌ | ❌ |`;cursor 原行 `Wraps` 改 `@cursor/sdk (chat-side fallback only)`;gemini 行末加 `— **deprecated 2026-09-27**, superseded by agy`。`:120` cheapEval 顺序改 `['openai','agy','claude','codex','gemini']`。
  - `:134` `pipeline-deps.ts:388` / `:136` `tick-bodies.ts:243` / `:142` `conversation-coordinator.ts:863` 删行号;`:130` 与 `:142` 注明 coordinator 在 `src/core/conversation-coordinator.ts`。
  - `:184` `src/lib/db.ts, v1–v15` → `src/lib/db.ts, one append-only migrations array (v67 as of 2026-09-26; user_version is a COUNT — see maintainer/migrations.md)`。
  - `:191-192` 保留「`_overview.md` 已停止更新」;`:286` D1 那格末尾加 `**2026-09-25 起** `_overview.md` 不再更新,每晚整理的 `memory.md` 取代它注入(§2.4)。`。
  - `:200` `prompt-builder.ts:346/509` 删行号。
  - `:209` `74 MB` → `~78 MB`。
  - `:216` STT 句改为 `STT is **inbound-ready but gateway-shaped** (`src/daemon/stt/*`, configured by `stt-config.json` → an OpenAI-shaped whisper endpoint; unset ⇒ voice notes are not transcribed); TTS is **remote** (VoxCPM2 gateway, `voice-config.json`). No host in code.`。
  - `:219` `(settings-panel.ts)` → `(source in apps/mobile/, assembled into src/daemon/mobile-page.generated.json; served by src/daemon/mobile-page.ts; the settings panel itself stays in settings-panel.ts)`。
  - `:292` Minor 行:`two state-dir env var names` → `two state-dir env var names (WECHAT_STATE_DIR is primary, WECHAT_CC_STATE_DIR legacy; daemon side unified in resolve-state-dir.ts, src/lib/config.ts still reads only the primary — see rules-from-real-machines.md)`。
- [ ] **Step 3:** §2.5 末尾加一条:

```markdown
- **Runtime adapter layer** (`src/lib/runtime/{sqlite,process,http,zstd}.ts`, 2026-09-16): business code never imports `bun:*` or touches `Bun.*` (depcruise rule `bun-builtins-only-in-runtime` + `no-bun-globals.test.ts`); Node 24 runs the whole `src/` suite via `npm run test:node`. Known gap: `process.ts` does not abstract `detached`/process groups, so ~30 spawn sites that need them still call `node:child_process` directly.
```

- [ ] **Step 4:** `grep -nE "\.ts:[0-9]+|v1–v15|17 mw|17-mw" docs/architecture.md` 应只剩免责声明里的说明句。
- [ ] **Step 5: Commit** `docs(architecture): 行号与计数改指针;provider 表补 agy/ACP;STT、/m 页、_overview、runtime 层按现状`

---

### Task 9: `docs/cc-workbench.md` 正文吸收 9 月机制

**Files:**
- Modify: `docs/cc-workbench.md`(在「离开电脑后从微信继续」之前插入三节;修订记录不动)

- [ ] **Step 1:** 插入(内容提炼自修订记录 09-17/09-18 条目,已核):

```markdown
## 任务里能看到什么(实时事件流)

每个任务有持久化 `seq`(`workbench_tasks.seq`),事件行带 `seq`;桌面用 `GET /v1/workbench/task?since=&wait_ms=` 长轮询(≤20s)只取变过的行。Claude 执行者开逐字流,两家的增量 150ms 合并后落库,正在跑的一组按增量补丁渲染,结构变化才整页重画。不嵌终端 —— 执行者的事件当数据渲染,才做得出「改动」「权限卡」「等待行」。

## 改动怎么审(逐文件 diff)

任务详情的「改动」面板按回合列出安静/唤醒边界的变更快照,逐文件展开 diff,每个文件可**接受**或**打回**;打回 = 一句意见 + 该文件 diff 节选,组成一条续接要求走 `POST /v1/workbench/review-return`(与普通续接同一道门)。标记存 `workbench_review_marks`,跨表面经长轮询同步。不做 hunk 级接受(等真实需求)。

## 免审执行者与 ACP

- **免审**(agy):用执行者 CLI 自己的跳过审批开关启动;daemon 仍守文件夹占用、目录身份、成果收集、diff 快照与停止,但看不到、拦不下单步。第一次选到要在桌面确认一次(`POST /v1/workbench/unattended-ack`,存 `agent-config.json` 的 `workbench_unattended_ack_at`),未确认返回 428 `unattended_ack_required`。微信 / Windows 上没有这个确认入口。
- **ACP**(Cursor):`cursor-agent acp`(Agent Client Protocol v1,stdio JSON-RPC)—— 命令逐次进权限卡(allow-once / reject-once),时间线有逐条活动行,`session/load` 接原会话,`close()` 确认进程组退出。工作区内的文件编辑由 Cursor 直接执行、不过权限卡(ACP 面上没有开关),每个任务开跑记一条提示。不注入 MCP、不做 elicitation;图片附件进 prompt。对话侧的 Cursor 同样常驻 ACP,按会话注入 wechat MCP。真机报文:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`。
```

- [ ] **Step 2:** 第 3 行「截至 2026-09-22」→「截至 2026-09-27(正文 09-27 补入 9 月机制;更早的逐日变更在修订记录)」。
- [ ] **Step 3: Commit** `docs(workbench): 正文补实时事件流、diff 审阅、免审与 ACP 三节`

---

### Task 10: 全景导图两处修订 + 重生成 HTML

**Files:**
- Modify: `docs/全景导图.md:56,80,88`
- Regenerate: `docs/全景导图.html`(`bun scripts/build-map.ts`)

- [ ] **Step 1:** 用 decision-map 技能的「实现时修订」写法改:
  - `:56` 末尾 ⟨⟩ 内追加:`。实现时修订(2026-09-18):对话侧改成每会话常驻 cursor-agent acp + 逐会话 wechat MCP,print 模式退休;「每轮 spawn + NDJSON」只剩 cheapEval 一次性评估还在用`。
  - `:80` `[待] Windows 拿不到工作台` → `- 做 **Windows 工作台文件层走纯 JS 锚定 + 进程树清理(jobspawn)** [定 2026-09-24] · 不做 ~~ffi 原生层~~ ⟨去 ffi 后 anchored-fs 先开再核;进程树清理 spike 09-23 判可行、09-24 落地 dev(src/lib/jobspawn.ts)。Codex 执行者与 Claude 保留会话在 win32 的真机验收仍欠⟩`。
  - `:88` `552 个提交三周没发` → `三周没发(提交数看 roadmap 现状表)`。
- [ ] **Step 2:** `bun scripts/build-map.ts && git status --short docs/` 必须看到 md 与 html 都变。
- [ ] **Step 3: Commit** `docs(导图): cursor 走 ACP 的实现时修订;Windows 工作台从[待]改[定];重生成 HTML`

---

### Task 11: CONTRIBUTING.md 与 reference / maintainer 小修

**Files:**
- Modify: `CONTRIBUTING.md`(整文件)
- Modify: `docs/reference/access-control.md:101-103`、`docs/reference/features.md:137,159`、`docs/reference/state-layout.md`、`docs/plugins.md:131-136`、`docs/maintainer/deploy.md:13`、`docs/maintainer/migrations.md:19`

- [ ] **Step 1 CONTRIBUTING.md** 替换全文:

```markdown
# 给协作者的小手册

规矩只有一份:[AGENTS.md](./AGENTS.md)(三条硬规矩 + 标准回路),维护者手册在 [docs/maintainer/README.md](./docs/maintainer/README.md)。这页只说外部 fork-PR 怎么进来。

- **从 `dev` 起分支,PR 打到 `dev`**;`master` 只接受 dev→master 的 squash PR(发版)。
- 本地四道闸门:`bun run test` / `npm run test:node` / `bun run typecheck` / `bun run depcheck`。
- commit 用 conventional 风格,PR 标题就是 squash 后的 commit。PR 描述写 **Why**。
- 用 AI 写代码可以,四个坑:别顺手改无关代码;测试盯断言别信 mock;`typecheck` 过 ≠ API 存在;secrets 别进 commit。
- CI 红了不知道为啥:`wechat-cc ci triage --wait` 会分桶(绿 / 真红 / 没跑 / 已知 flake),细则 [docs/maintainer/ci-and-flakes.md](./docs/maintainer/ci-and-flakes.md)。
```

- [ ] **Step 2** 小修:
  - `access-control.md:101-103` 括号句 → `(` + "`wechat-cc provider set openai --base-url <url> --model <model>`" + ` writes the same three fields.)`。
  - `features.md:137` `v2.0 moved all 22 tools` → `v2.0 moved all tools`;`:159` `Claude (claude-haiku-4-5, isolated single-shot)` → `the cheap-eval provider (` + "`/set cheap`" + `, isolated single-shot)`。
  - `state-layout.md` 树里 `internal-token` 行后加:`├── internal-operator-token # desktop host's admin credential, route-scoped (0600)`、`├── agent-config.json      # provider / model / workbench knobs (typed saver in src/lib/agent-config.ts)`、`├── daemon.env             # API keys written by the settings panel (0600)`、`├── projects.json          # registered project folders`、`├── conversations.json     # legacy — migrated to wechat-cc.db`、`├── stt-config.json / voice-config.json  # STT / TTS gateways`、`├── settings-devices.json  # paired phone device tokens (≤20)`、`├── license.json           # Pro tier`、`├── self-change/           # one git worktree per self-change run`、`├── plugins/               # user plugins (default disabled)`、`├── memory/<chat_id>/memory.md  # nightly-curated long-term memory (injected every turn)`;树顶加一句 `Override the root with WECHAT_STATE_DIR.`。
  - `plugins.md:131-136` 代码块加三行:`wechat-cc plugin upgrade <name>`、`wechat-cc plugin setup <name>       # build the plugin's .venv`、`wechat-cc plugin setup-status <name>`。
  - `deploy.md:13` `--binary <path>(缺省 …)` → `--binary <path>(源码模式缺省 apps/desktop/src-tauri/binaries/wechat-cc-cli-<arch>-apple-darwin;**打包版必填**)`。
  - `migrations.md:19` 第 1 条 → `1. `src/lib/state-migration.test.ts` —— 2026-09 起断言 `toBe(migrations.length)`,不用再手改 N;只需确认它仍然绿。`。
- [ ] **Step 3: Commit** `docs: CONTRIBUTING 指向 AGENTS;reference/maintainer 六处按代码改正`

---

### Task 12: 守卫测试 —— 路由白名单一致性

**Files:**
- Create: `scripts/route-registry.guard.test.ts`

**Interfaces:** Consumes `ROUTE_MIN_TIER`(`src/daemon/internal-api/route-tiers.ts`)、`makeTokenRegistry`(`token-registry.ts`,`registerOperatorToken` 后 `resolve` 得到 `routeAllow`)。

- [ ] **Step 1: 写测试**

```ts
/**
 * 路由白名单的**接缝守卫**(2026-09-27,梳理第 3 步)。
 *
 * 桌面能调的一条内部 API 路由要登记在四处:route-tiers(tier)→ token-registry 的
 * operator routeAllow → apps/desktop/workbench-proxy.ts(dev 代理)→ src-tauri lib.rs
 * 的 workbench_request_allowed(打包版代理)。此前四份各自手抄、各自有测试,但没有
 * 一条测试比对它们 —— 漏一处的症状是「只在打包版出现的 403 route_not_allowed」。
 * 这里钉住包含关系:lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_MIN_TIER } from '../src/daemon/internal-api/route-tiers'
import { makeTokenRegistry } from '../src/daemon/internal-api/token-registry'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

function rustAllowed(): Set<string> {
  const src = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs')
  const start = src.indexOf('fn workbench_request_allowed')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end)
  const out = new Set<string>()
  for (const m of body.matchAll(/\(\s*"(GET|POST)"\s*,\s*"(\/v1\/[^"]+)"\s*\)/g)) out.add(`${m[1]} ${m[2]}`)
  return out
}

function proxyAllowed(): Set<string> {
  const src = read('apps', 'desktop', 'workbench-proxy.ts')
  const start = src.indexOf('const ROUTES = new Set([')
  const end = src.indexOf('])', start)
  const out = new Set<string>()
  for (const m of src.slice(start, end).matchAll(/'((?:GET|POST) \/v1\/[^']+)'/g)) out.add(m[1]!)
  return out
}

function operatorAllowed(): Set<string> {
  const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
  reg.registerOperatorToken('op')
  return new Set(reg.resolve('op')!.routeAllow!)
}

const diff = (a: Set<string>, b: Set<string>) => [...a].filter(k => !b.has(k))

describe('桌面可达路由四份白名单对得上', () => {
  const rust = rustAllowed(), proxy = proxyAllowed(), op = operatorAllowed()

  it('三份都真的抓到了东西(正则没抓空 = 守卫沉默,比误报危险)', () => {
    expect(rust.size).toBeGreaterThanOrEqual(30)
    expect(proxy.size).toBeGreaterThanOrEqual(25)
    expect(op.size).toBeGreaterThanOrEqual(40)
  })

  it('lib.rs 放行的每一条,dev 代理也放行(打包版能调的,浏览器预览也得能调)', () => {
    // matter 四条与 workbench 走的是同一个 Rust 命令,但 dev 代理只管 /v1/workbench*:
    // 它们经 test-shim 另一条路,不在 workbench-proxy.ROUTES 里。这是已知形状,不是漏登记。
    const onlyRust = diff(rust, proxy).filter(k => !k.includes('/v1/matter'))
    expect(onlyRust, '在 lib.rs 里但不在 apps/desktop/workbench-proxy.ts:ROUTES').toEqual([])
  })

  it('dev 代理放行的每一条,lib.rs 也放行(别让功能只在浏览器预览里能用)', () => {
    expect(diff(proxy, rust), '在 workbench-proxy.ts 里但不在 lib.rs workbench_request_allowed').toEqual([])
  })

  it('lib.rs 放行的每一条,operator token 的 routeAllow 都有(否则 daemon 侧 403 route_not_allowed)', () => {
    expect(diff(rust, op), '在 lib.rs 里但不在 token-registry.ts routeAllow').toEqual([])
  })

  it('routeAllow 里的每一条都在 ROUTE_MIN_TIER 登记过(没登记 = admin,operator 恰好是 admin,所以此前静默)', () => {
    expect(diff(op, new Set(Object.keys(ROUTE_MIN_TIER))), '在 routeAllow 里但 route-tiers.ts 没登记').toEqual([])
  })
})
```

- [ ] **Step 2: 跑** `bun --bun vitest run scripts/route-registry.guard.test.ts`。预期:前四条绿;若第 2/3 条红,输出的差集就是真漂移 —— 记下来,**不要为了让测试绿而放宽断言**;若差集是 `matter` 之外的路由,修对应白名单(补漏的那一处)。
- [ ] **Step 3:** 若 Step 2 发现漂移并修了白名单,同时更新 `token-registry.test.ts` 里的精确集合(它会红)。
- [ ] **Step 4: Commit** `test(guard): 桌面可达路由四份白名单的包含关系`

---

### Task 13: 守卫测试 —— provider 枚举一致性

**Files:**
- Create: `scripts/provider-registry.guard.test.ts`

- [ ] **Step 1: 写测试**

```ts
/**
 * provider 枚举的**接缝守卫**(2026-09-27,梳理第 3 步)。
 *
 * 加一家 provider 要碰约 12 处,其中至少 8 份是各自手抄的 id 名单。这里只钉
 * 「每份名单都以 src/lib/provider-ids.ts 为准」:少一家 = 该处功能对新家沉默,
 * 多一家 = 引用不存在的 id。能力矩阵完整性此前只在 boot 时断言,测试里没有。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/lib/provider-ids'
import { capabilitiesFor } from '../src/core/capability-matrix'
import { providerDisplayName } from '../src/core/provider-display-names'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const IDS = [...PROVIDER_IDS].sort()

describe('provider 名单都以 provider-ids.ts 为准', () => {
  it('能力矩阵每家一行(capabilitiesFor 对未知 id 会 throw)', () => {
    for (const id of PROVIDER_IDS) expect(() => capabilitiesFor(id)).not.toThrow()
  })

  it('展示名表 KNOWN_NAMES 的键集合 = provider-ids(不靠首字母大写兜底)', () => {
    const src = read('src', 'core', 'provider-display-names.ts')
    const m = /const KNOWN_NAMES[^=]*=\s*Object\.freeze\(\{([^}]+)\}/.exec(src)
    expect(m, 'provider-display-names.ts 里找不到 KNOWN_NAMES').toBeTruthy()
    const keys = [...m![1]!.matchAll(/(\w+)\s*:/g)].map(x => x[1]!).sort()
    expect(keys).toEqual(IDS)
    for (const id of PROVIDER_IDS) expect(providerDisplayName(id).length).toBeGreaterThan(0)
  })

  it('桌面 dashboard.js 的 PROVIDER_LABELS 键集合 = provider-ids', () => {
    const src = read('apps', 'desktop', 'src', 'modules', 'dashboard.js')
    const m = /const PROVIDER_LABELS = \{([^}]+)\}/.exec(src)
    expect(m, 'dashboard.js 里找不到 PROVIDER_LABELS').toBeTruthy()
    const keys = [...m![1]!.matchAll(/(\w+)\s*:/g)].map(x => x[1]!).sort()
    expect(keys).toEqual(IDS)
  })

  it('mode-commands.ts 的 KNOWN_SLASH_COMMANDS 首行(isProviderCommand)= provider-ids 的斜杠形式', () => {
    const src = read('src', 'daemon', 'mode-commands.ts')
    const m = /const KNOWN_SLASH_COMMANDS = new Set\(\[\s*([^\n]+)\/\/ isProviderCommand/.exec(src)
    expect(m, '找不到 KNOWN_SLASH_COMMANDS 的 isProviderCommand 行').toBeTruthy()
    const slashes = [...m![1]!.matchAll(/'(\w+)'/g)].map(x => x[1]!).sort()
    // 两个历史命名:claude 的斜杠是 /cc,openai 的是 /api;其余同名
    const SLASH_OF: Record<string, string> = { claude: 'cc', openai: 'api' }
    const expected = IDS.map(id => SLASH_OF[id] ?? id).sort()
    expect(slashes).toEqual(expected)
  })

  it('桌面「选择已有账号」芯片只列订阅 CLI 三家,且都是真 id', () => {
    const src = read('apps', 'desktop', 'src', 'main.js')
    const m = /\[('claude','codex','cursor')\]\.map/.exec(src)
    expect(m, 'main.js nb-cli 芯片列表形状变了,更新这条守卫').toBeTruthy()
    for (const id of ['claude', 'codex', 'cursor']) expect(IDS).toContain(id)
  })
})
```

- [ ] **Step 2: 跑** `bun --bun vitest run scripts/provider-registry.guard.test.ts`。预期全绿。若某条红,先确认是正则没抓到(改正则)还是真漂移(修被测那份名单),**不放宽断言**。
- [ ] **Step 3: Commit** `test(guard): provider 枚举四处以 provider-ids 为准`

---

### Task 14: 守卫测试 —— cli.ts 棘轮 + 版本 / bun 钉死补漏

**Files:**
- Create: `scripts/cli-ratchet.guard.test.ts`
- Modify: `scripts/version-consistency.guard.test.ts`(加 Cargo.toml)
- Modify: `apps/desktop/src-tauri/Cargo.toml:3`(`0.6.3` → `1.7.0`)、`apps/desktop/src-tauri/Cargo.lock`(`wechat_cc_desktop` 包的 version)
- Modify: `scripts/ci-workflow.guard.test.ts`(bun 钉死覆盖 desktop.yml / publish-update.yml)
- Modify: `.github/workflows/desktop.yml:124,424`、`.github/workflows/publish-update.yml:42`(`latest` → `1.3.14`)

- [ ] **Step 1: cli-ratchet 测试**

```ts
/**
 * cli.ts 的**棘轮守卫**(2026-09-27,梳理第 3 步)。
 *
 * 根 cli.ts 是 4332 行、127 个 defineCommand 的命令树,动态 import src/daemon 内部
 * 39 处。depcruise 的 cli-must-not-depend-on-daemon 只管 ^src/cli/,根文件不受约束。
 * 拆它是第 7 步的事;这一步先钉住「不再增长」:行数与 daemon 动态 import 数只许降。
 * 下沉一个命令后把这两个上限往下调 —— 棘轮只往一个方向转。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'cli.ts'), 'utf8')

const MAX_LINES = 4332
const MAX_DAEMON_IMPORTS = 39

describe('cli.ts 只许变小', () => {
  it(`行数 ≤ ${MAX_LINES}(新命令去 src/cli/<group>.ts,cli.ts 只登记)`, () => {
    expect(src.split('\n').length).toBeLessThanOrEqual(MAX_LINES)
  })
  it(`动态 import src/daemon 的次数 ≤ ${MAX_DAEMON_IMPORTS}(cli 应 spawn daemon,不链接它)`, () => {
    const n = (src.match(/import\('\.\/src\/daemon\//g) ?? []).length
    expect(n).toBeLessThanOrEqual(MAX_DAEMON_IMPORTS)
  })
})
```

- [ ] **Step 2:** 跑 `bun --bun vitest run scripts/cli-ratchet.guard.test.ts`,绿(等于上限)。
- [ ] **Step 3: 版本守卫加 Cargo.toml。** `version-consistency.guard.test.ts` 的 `describe('四处版本号对得上')` 里加:

```ts
  it('Cargo.toml 也跟着(2026-09-26 梳理抓到它停在 0.6.3;tauri 打包不读它,但 self deploy 与人读)', () => {
    const cargo = read('apps', 'desktop', 'src-tauri', 'Cargo.toml')
    expect(/^version = "([^"]+)"/m.exec(cargo)?.[1]).toBe(tauri)
  })
```

  跑测试 → 红(0.6.3);改 `Cargo.toml:3` 为 `version = "1.7.0"`;`Cargo.lock` 用 `grep -n -A1 'name = "wechat_cc_desktop"' apps/desktop/src-tauri/Cargo.lock` 定位到 `version = "0.6.3"` 那行改 `1.7.0`;再跑 → 绿。describe 名改「五处版本号对得上」。
- [ ] **Step 4: bun 钉死扩到发版 workflow。** 先改 `desktop.yml:124,424` 与 `publish-update.yml:42` 的 `bun-version: latest` → `bun-version: 1.3.14`。然后 `ci-workflow.guard.test.ts` 的「bun 版本钉死」describe 改成遍历三个文件:

```ts
describe('三个 workflow —— bun 版本钉死', () => {
  it('ci.yml / desktop.yml / publish-update.yml 每一处 setup-bun 都是 1.3.14(2026-09-15 bun 1.4.2 把 CI 弄红;发版链此前仍是 latest)', () => {
    const pins: unknown[] = []
    for (const file of ['ci.yml', 'desktop.yml', 'publish-update.yml']) {
      const doc = parse(read('.github', 'workflows', file)) as { jobs: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }> }
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@')) pins.push(step.with?.['bun-version'])
        }
      }
    }
    expect(pins.length).toBeGreaterThanOrEqual(6)
    for (const p of pins) expect(p).toBe('1.3.14')
  })
})
```

  (`parse` 与 `read` 沿用该文件已有的 yaml 解析与读文件辅助;若名字不同,按文件里现有的用。)
- [ ] **Step 5:** `bun --bun vitest run scripts/` 全绿。
- [ ] **Step 6: Commit** `test(guard): cli.ts 棘轮;版本守卫补 Cargo.toml;发版 workflow 的 bun 也钉 1.3.14`

---

### Task 15: 删桌面 `sessions.js` 的死路径

**Files:**
- Modify: `apps/desktop/src/modules/sessions.js`、`apps/desktop/src/modules/sessions.test.ts`、`apps/desktop/src/main.js:1419-1431`

- [ ] **Step 1: 生成 keep 表。** 对 sessions.js 的每个 `export`,跑:

```bash
cd apps/desktop/src && for f in $(grep -oE "^export (async )?function \w+" modules/sessions.js | awk '{print $NF}'); do n=$(grep -rn "\b$f\b" --include='*.js' --include='*.html' . | grep -v "modules/sessions.js" | grep -v "\.test\." | wc -l); echo "$n $f"; done | sort -n
```

  预期 0 引用:`loadSessionsList openProjectDetail closeProjectDetail selectChat startDetailAutoRefresh stopDetailAutoRefresh turnHtml turnHtmlCompact setSessionsDetailMode deleteProject startSessionsAutoRefresh stopSessionsAutoRefresh searchHitRow groupProjectsByRecency projectRow readFavorites toggleFavorite`(以实际输出为准;`main.js:1425` 的 `openProjectDetail` 引用在 Step 3 一起删)。
- [ ] **Step 2:** 删这些函数及只被它们用的模块级状态(`selectedChatId` 等 `let`、detail 定时器变量)与内部辅助。保留有引用的:`loadSessionsChats exportProjectMarkdown wireSearch attachmentUrl avatarInitial avatarInfo deleteProjectByAlias` 及它们依赖的纯函数(`extract*`、`formatChatTimestamp`、`avatarColor`、`sessionHasReplyTool`、`buildExportMarkdown`)。文件头注释加一行:`2026-09-27:旧「会话」pane 的 DOM(#sessions-detail 等)2026-06-04 已删,对应渲染路径同日死;本次删掉,只留 dialogue-page / settings-drawer 还在用的导出。`
- [ ] **Step 3:** `main.js` 的 `reopenCurrentSession` 删掉 `sessions-detail` 分支,只留 dialogue 刷新:

```js
/** @param {typeof deps} deps */
function reopenCurrentSession(deps) {
  // If the dialogue pane is mounted, refresh its timeline so new avatars appear.
  const dialogueRoot = document.getElementById("dialogue-root")
  if (dialogueRoot?.dataset.ready === "true") {
    import("./modules/dialogue-page.js").then(m => m.initDialoguePage(deps))
  }
}
```

- [ ] **Step 4:** `sessions.test.ts` 删 `groupProjectsByRecency` / `projectRow` / `searchHitRow` / `turnHtml` 四个 describe(及其 import)。
- [ ] **Step 5:** `bun --bun vitest run apps/desktop/src/modules/sessions.test.ts apps/desktop/src/module-syntax.test.ts apps/desktop/src/modules/dialogue-page` 绿;`wc -l apps/desktop/src/modules/sessions.js` 应明显小于 1404。
- [ ] **Step 6: Commit** `desktop: 删 sessions.js 里 06-04 起就没有 DOM 的旧会话面板路径`

---

### Task 16: 删桌面「客户回顾」前端模块

**Files:**
- Delete: `apps/desktop/src/modules/customer-review.js`、`customer-review-utils.js`、`customer-review.test.ts`
- Modify: `apps/desktop/src/index.html:638`、`apps/desktop/src/main.js:36 及 stopCustomerReviewPolling 调用处`、`apps/desktop/src/styles.css`(所有 `customer-review` 规则)、`apps/desktop/src/api.js:133-142`、`apps/desktop/src/api.test.ts`(customer-review 用例)、`apps/desktop/test-shim.ts:387-405`
- **不动**:`src/daemon/customer-review/*`、`routes-customer-review.ts`(后端路由 08-24 owner 定「暂留」)、`lib.rs` 的 `customer_review_api`(同时服务 待办 的 OWNER_WORKSPACE_PATHS)、`api.js` 的 `callOwnerWorkspace`。

- [ ] **Step 1:** `grep -rn "customer" apps/desktop/src/main.js apps/desktop/src/api.js apps/desktop/src/api.test.ts apps/desktop/src/index.html apps/desktop/test-shim.ts apps/desktop/playwright` 列出每一处,逐处处理:
  - `main.js:36` 删 import;找到 `stopCustomerReviewPolling(` 的调用(`switchPane` 里)删那一行;`:1484` 附近的注释若只提客户回顾,改成提 待办。
  - `index.html:638` 删 `#customer-review-root` 那个 div。
  - `styles.css`:删所有选择器含 `customer-review` / `.cr-` 的规则块(先 `grep -n "customer-review\|\.cr-" styles.css | head` 看命名,再删;删完 `grep -c customer-review` 为 0)。
  - `api.js:140` 条件 `path.startsWith('/v1/customer-review') || OWNER_WORKSPACE_PATHS.has(...)` → 只留 `OWNER_WORKSPACE_PATHS.has(...)`;`:55-63` 注释里把「customer_review_api」的由来改成「待办(原客户回顾)」。`api.test.ts` 里断言 customer-review 路径走 host 的用例改成 OWNER_WORKSPACE 路径或删。
  - `test-shim.ts:387-405` 删 `/v1/customer-review` 代理块(待办那块保留)。
- [ ] **Step 2:** 删三个文件。`bun --bun vitest run apps/desktop/src` 绿;`grep -rn "customer-review\|customerReview" apps/desktop/src` 只剩 api.js 注释(或 0)。
- [ ] **Step 3:** `cd apps/desktop && bun x playwright test` 若本机 4176 空闲则跑一遍(记忆规矩);占用则跳过并在 commit message 注明。
- [ ] **Step 4: Commit** `desktop: 删 08-24 退役的客户回顾前端模块(后端路由与 Rust 代理保留,待办仍用)`

---

### Task 17: 删 `log-viewer.ts`

**Files:**
- Delete: `log-viewer.ts`
- Modify: `package.json:40`(depcheck 列表去掉它)、`.github/workflows/ci.yml:110-112`(删 Build log-viewer.ts 步)、`src/lib/spawn-windowshide.test.ts:55-59`(注释与 `SCAN_ROOT_FILES` 去掉它)、`docs/maintainer/ci-and-flakes.md:7`(去掉 `log-viewer.ts`)

- [ ] **Step 1:** `grep -rn "log-viewer" src apps scripts package.json docs/maintainer README.md .dependency-cruiser.cjs` 与 ci.yml 里的引用全部处理掉;删文件。
- [ ] **Step 2:** `bun --bun vitest run src/lib/spawn-windowshide.test.ts scripts/ci-workflow.guard.test.ts && bun run depcheck` 绿。
- [ ] **Step 3: Commit** `chore: 删 log-viewer.ts(0 importer;CLI logs 是另一套)`

---

### Task 18: 删废弃脚本 + msw

**Files:**
- Delete: `scripts/send-wanan-voice.ts`、`scripts/voice-bubble-sweep.ts`、`scripts/smoke-checks.sh`、`scripts/voxcpm-tunnel.ps1`、`scripts/acceptance-p0p1.ts`、`scripts/windows-build.ps1`、`scripts/prompt-audit.ts`、`apps/desktop/scripts/extract-animation-assets.py`、`apps/desktop/scripts/keep-largest-alpha.py`、`apps/desktop/scripts/remove-checker-background.py`
- Modify: `src/lib/token-estimate.ts`(若引用 prompt-audit 只是注释,改注释)、`package.json`(去 msw)、`bun.lock`

- [ ] **Step 1:** 对每个文件跑 `grep -rn "<basename>" src apps scripts package.json docs/maintainer docs/INDEX.md README.md`,除 `prompt-audit`(`src/lib/token-estimate.ts` 一处)外必须为空。看 token-estimate.ts 那一处:是注释 ⇒ 改成「(曾给 scripts/prompt-audit.ts 用,2026-09-27 删)」;是 import ⇒ **不删 prompt-audit**,记入执行记录。
- [ ] **Step 2:** `git rm` 上述文件。`bun remove msw`(会改 package.json 与 bun.lock;确认 `grep -rn "msw" src apps scripts eval` 为空)。
- [ ] **Step 3:** `bun install --frozen-lockfile && bun run typecheck` 绿。
- [ ] **Step 4: Commit** `chore: 删 10 个 0 引用脚本(含两个会打真微信的)与未用的 msw`

---

### Task 19: gemini provider 标 deprecated

**Files:**
- Modify: `src/core/gemini-agent-provider.ts:1-13`(头注释)、`src/daemon/bootstrap/providers.ts:556-575`(注释 + 注册日志)、`src/daemon/mode-commands.ts`(help 里 `/gemini` 一句)

- [ ] **Step 1:** `gemini-agent-provider.ts` 头注释第一行改为:`/** * Gemini agent provider — drives Gemini via @google/genai. * * @deprecated 2026-09-27:订阅版 Gemini 走 agy(Antigravity CLI,真 resume、cheapEval 顺序在前);这条 API-key 路保留给已配 GEMINI_API_KEY 的用户,不再加功能。主人拍板「标 deprecated 保留」。`
- [ ] **Step 2:** `providers.ts` 注册成功那条 `deps.log('BOOT', …)` 后加一行:`deps.log('BOOT', 'gemini (API key) is deprecated since 2026-09-27 — prefer /agy (subscription Gemini via Antigravity CLI); this path is kept for existing GEMINI_API_KEY users and gets no new features.')`;段首注释 `// Gemini provider — fifth registered provider.` 后加 `// DEPRECATED 2026-09-27, see gemini-agent-provider.ts header.`
- [ ] **Step 3:** `mode-commands.ts` help 那行 `/agy 是订阅 CLI:…` 前加:`'/gemini 是 API key 版(已弃用,保留给已配 GEMINI_API_KEY 的人);新接入请用 /agy。',`。若 `mode-commands.test.ts` 钉了 help 全文,更新它。
- [ ] **Step 4:** `bun --bun vitest run src/daemon/mode-commands src/daemon/bootstrap/providers` 绿。
- [ ] **Step 5: Commit** `providers: gemini(API key)标 deprecated,注册日志与 /help 指向 agy`

---

### Task 20: AGENTS.md / rules-from-real-machines / package.json script

**Files:**
- Modify: `AGENTS.md:15`、`package.json:scripts`、`docs/maintainer/rules-from-real-machines.md`

- [ ] **Step 1:** `AGENTS.md:15` `(HTML 是生成物,永不手改)` → `(HTML 是生成物,永不手改;改完 md 跑 `bun run build:map`)`。`package.json` scripts 加 `"build:map": "bun scripts/build-map.ts"`。
- [ ] **Step 2:** `rules-from-real-machines.md` 「路由登记」节末尾加:`- 2026-09-27 起四份白名单的包含关系由 `scripts/route-registry.guard.test.ts` 钉住;漏登记会在本地就红,不用等打包版。`。新增一节「只在代码注释里的规矩(2026-09-27 抄出来)」:

```markdown
## 承重但此前只写在代码注释里的规矩

- **新接线进 `src/daemon/bootstrap/wire-*.ts`,别再往 `bootstrap/index.ts` 里加**(`index.ts` 头注释)。`index.ts` 已 1123 行、7 月以来改了 84 次。
- **STATE_DIR 两个环境变量名的优先级是 `WECHAT_STATE_DIR` > `WECHAT_CC_STATE_DIR`**(`src/daemon/resolve-state-dir.ts` 头注释);`src/lib/config.ts` 只认前者。e2e harness 两个都设,所以测试发现不了漂移 —— 改 state-dir 相关代码时手动只设一个名试。
- **入站链开了意图路由后,每个在场消费者必须交探针,漏一个 boot 即抛**(`src/daemon/inbound/build.ts` 注释);探针要看的字段(附件、语音转文字)必须在路由之前就绪。
- **A2A `proto_version` 现在是 3**(`src/core/a2a-intent.ts`);改信封形状要升它,两台真机都得重新配对。
- **`agent-config.json` 只经 `saveAgentConfig` 写**;裸读改写(2026-09 还有四处)会互相覆盖字段,09-17 丢过 `workbench_unattended_ack_at`。
```

- [ ] **Step 3: Commit** `docs: AGENTS 写明导图生成命令;真机规矩补五条只在代码注释里的`

---

### Task 21: 四道闸门 + 推分支

- [ ] **Step 1:** `bun run test`(与基线比:只许 Task 0 那条红,且本分支删掉的测试数要对得上)。
- [ ] **Step 2:** `npm run test:node`。
- [ ] **Step 3:** `bun run typecheck && bun run depcheck`(depcheck 仍是 0 error;warn 数不增)。
- [ ] **Step 4:** `git log --oneline origin/dev..HEAD` 应约 20 条;`git push -u origin sweep/2026-09-26-audit-followup`。
- [ ] **Step 5:** `wechat-cc ci triage --branch sweep/2026-09-26-audit-followup --wait --rerun`(CI 只对 dev/master/self/** 触发 push;分支若不触发,记「CI 未跑,合 dev 后看」)。
- [ ] **Step 6:** 汇报:分支名、commit 列表、四道闸门结果、Task 0 的红、Task 12 若发现的白名单漂移、需要整合者合入 dev。

## 执行记录

(执行时填)
