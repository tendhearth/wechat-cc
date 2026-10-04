# 外部 agent CLI 自动升级

> **主人 2026-10-04 拍板:** wechat-cc **全自动**(默认开)把外部 agent CLI —— Claude Code、Codex、cursor-agent、agy —— 保持最新,因为人会忘;输出格式 / 协议的不兼容要**自动**发现。

代码:`src/core/cli-upgrade/`(引擎,全部副作用注入)、`src/daemon/cli-upgrade/`(daemon 接线、自检)、`src/cli/commands/cli.ts` + `src/cli/agent-cli-status.ts`(命令)。

## 一句话流程

发现(每天一次 + 报错触发)→ **空闲时**用 CLI **自己的官方升级器**升 → 立刻跑自检(对话 + 工作台 + 协议烟测)→ 过了发一句「Codex 已自动升级到 0.160.0，自检通过」;没过就**自动退回**、重跑自检、把这个版本记成**有问题的版本**(更新的版本出来之前不再升到它)、告诉主人**一次**;退不回就给手动步骤。

## 四家各自怎么做

| CLI | 查最新(只读) | 升级器 | 能不能自动退回 |
|---|---|---|---|
| Claude Code | npm `@anthropic-ai/claude-code` 的 dist-tag,跟着 `~/.claude/settings.json` 的 `autoUpdatesChannel`(stable / latest) | `claude update` | 原生安装 `~/.local/bin/claude → ~/.local/share/claude/versions/<v>`:旧版本留在 versions 里 ⇒ **改链接指回去**;本机没有那个版本 ⇒ 官方 `claude install <v>` |
| Codex | npm `@openai/codex` 的 `latest` | `codex update` | standalone 安装 `~/.codex/packages/standalone/current → releases/<v>-<平台>`:旧版本留在 releases 里 ⇒ **把 `current` 改指回去**;npm / brew 装法 ⇒ 退不回,给手动步骤 |
| cursor-agent | Cursor 官方安装脚本(`https://cursor.com/install`)里写死的版本目录 | `cursor-agent update` | `~/.local/bin/{cursor-agent,agent} → ~/.local/share/cursor-agent/versions/<v>/cursor-agent`:旧版本留着 ⇒ **两个链接一起改指回去** |
| agy | **没有**只读来源(它的更新服务是私有接口,不去逆向) ⇒ 定时检查直接跑升级器,升级器自己判有没有新版 | `agy update` | 单个文件、升级器原地替换,**不留旧版本** ⇒ 退不回,通知里给手动步骤 |

规矩(见 [codex 版本耦合定案](../../src/lib/find-codex-binary.ts) 的头注释,2026-09-09):**版本号判不出能不能用;用主人自己装的 CLI;第一次用 / 升级后真跑一轮才算数;不按版本号拒;不打包二进制。** 所以这里从不自己下载、不替换二进制;改链接只是把入口指回 CLI 安装器自己留在盘上的那一份,和安装器切版本是同一个动作(建临时链接再 `rename`,任何一刻入口都指着一个完整版本)。SDK 自带的 claude(`node_modules/@anthropic-ai/claude-agent-sdk*`)认成 `bundled`,不碰。

## 什么时候查、什么时候升

- **每天一次**:本地 `check_hour`(缺省 4 点)之后的第一拍,每个 CLI 查一次装的版本和最新版本。
- **报错触发**(`core/cli-upgrade/outdated-signal.ts`,只看错误通道,不扫正文):
  - codex:`… model requires a newer version of Codex …` 与 `… model is not supported when using Codex with a ChatGPT account.`(都是真机采到的,见 [provider-error-shapes](../reference/provider-error-shapes.md));工作台码 `execution_model_unsupported`;
  - cursor:整块 `Check your settings to continue`(cursor-agent 把 OUTDATED_CLIENT 和 key 错误并在这一句里,分不开 ⇒ 去查一下版本);
  - claude / agy:**真机还没采到过**「客户端太旧」的原文,现在是几句按惯用措辞写的猜测 —— 命中只会多查一次版本,采到真句子后替换。
  命中后去抖 30 分钟,下一拍去查;有新版就和定时检查一样排队等空闲。来源是对话回合(`TurnRecord`,main.ts 的 `onTurnRecord`)与工作台(`makeWorkbenchService({ onTurnError })`)。
- **CLI 自己在后台升了**(claude / codex / agy 都有自带的后台升级器):检查时发现装的版本 ≠ 上次接受的版本 ⇒ 欠一次自检,空闲时补做;不过同样退回到上次接受的版本。外面升的、自检通过的**不发通知**(只记在 health 里),免得 Claude 一天一升一天一条。
- **查最新失败**:指数退避 1h → 2h → 4h … ≤ 24h(断网 / 网络不稳时不一分钟打一次,不制造重试风暴)。升级器失败同样退避,CLI 原样不动。

## 只在空闲时动手,永不打断

`daemon/cli-upgrade/wire.ts` `makeIdleCheck`:

1. 没有任何在途回合(`SessionManager.anyInFlight()`);
2. 这一家没有活会话(缓存的会话 30 分钟没用会被扫掉,之后才轮得到);
3. busy 登记处里除了我们自己(`cli-upgrade:<id>`)和正在请求我们的那条内部 API(`api:POST /v1/cli/upgrade|rollback`)之外没人 —— 工作台在跑的任务、A2A 委派、终端会话续接、伙伴推送都在里面。

判不出来按忙。动手期间(升级 + 自检 + 退回)持 `cli-upgrade:<id>` busy token,空闲自动重启不会切进来。同一时刻只做一件(升级 / 退回 / 补自检),第二件直接回 `busy`。

## 升级后的自检

`daemon/cli-upgrade/verify.ts`,和 `wechat-cc selftest` 是同一套:

1. **对话**(同 `selftest chat --resume`,daemon 里直接调 `runSelftestConverse`):一轮「调 wechat MCP 的 ping」+ 一轮续接。检查 `replied` / `tool_seen`(agy 不要求 —— 它的 MCP 真连还没在真机验过)/ `no_error` / `resume_replied`。
2. **协议烟测** `protocol_events`:那一轮经过**我们自己的解析器**出来的事件种类里,`text` / `result`(要求工具时还有 `tool_call`)必须都在。CLI 换了输出格式、解析器认不出时它最先红。
3. **工作台**(claude / codex / cursor;agy 是免审执行者,「权限往返」那一项对它不成立):直接调 CLI 的 `runWorkbenchSelftest`,走本机回环的内部 API,和主人在终端里跑 `selftest workbench --resume` 是同一段代码。

**哪些失败不算 CLI 坏了**(⇒ `deferred`:标「未验证」,30 分钟后重试,**不退回、不记坏版本**):

- 网络守护说此刻不安全(自检是模型调用,要过守护;下载 / 查元数据不过守护)—— 先问守护,一个字都不发;
- 供应商侧的结构化码:`quota` / `rate_limited` / `auth_failed` / `auth_rejected` / `network` / `server_error`(工作台里对应的固定人话也认)。`invalid_request` 不在里面 ——「这个模型需要更新的 CLI」恰恰是它。

这家 provider 这次没在 daemon 里注册(比如 agy 开机探测没过)⇒ `skipped`:接受这个版本、标「未验证」,不重试。

## 设置

`agent-config.json`:

```jsonc
"cli_auto_upgrade": {
  "enabled": true,        // 缺省 true
  "check_hour": 4,        // 0–23,缺省 4
  "per_cli": { "agy": { "enabled": false } }   // 逐个关
}
```

关掉只停「自动」;手动命令照样能用。改完下一拍(一分钟内)生效,不用重启。

## 命令

```bash
wechat-cc cli status [--check] [--json]   # 本机只读:装在哪、什么版本、升级器、能不能自动退回、daemon 记下的状态;--check 现查最新(不装、不写状态)
wechat-cc cli upgrade <claude|codex|cursor|agy> [--force] [--json]   # 交给在跑的 daemon:先查最新,空闲才升,升完自检,不过自动退回
wechat-cc cli rollback <claude|codex|cursor|agy> [--json]            # 退回上一个版本,当前版本记为有问题,退回后自检
```

`upgrade` / `rollback` 走 `POST /v1/cli/upgrade|rollback`(admin 档,operator 凭据,`token-registry` 的 routeAllow 里登记过;桌面不调)。退出码 0 成功 / 1 没做成(`not_idle`、`busy`、`failed`、`rolled_back` 后自检仍不过……)/ 2 daemon 没在跑。整个过程在一次请求里做完,可能要几分钟。

## 看得见

- `GET /v1/health` 的 `cli_upgrade` 块:每家 `installed` / `latest` / `update_available` / `accepted` / `verify`(ok / failed / unverified / unknown)/ `last_check_at` / `last_check_error` / `next_check_at` / `pending` / `last_upgrade`(from、to、来源、结果)/ `known_bad`。只有版本号和时间,没有路径(这条路由是 guest 档)。
- 状态文件 `<STATE_DIR>/cli-upgrade.json`(只有 daemon 写)。
- 日志 tag `CLI_UPGRADE`。
- 通知:微信发给主人 + 桌面系统通知,同一件事只说一次(`notified` 键)。

## 测试

全部用临时目录里的**假 CLI**(真 exec 一个 `#!/bin/sh` 脚本,布局和官方安装器一样),升级器 / 退回都在临时目录里改链接;查最新用注入的 fetch。**永远不碰主人真装的 CLI。** 假 CLI 是 POSIX 脚本,win32 跳过。

- `src/core/cli-upgrade/engine.test.ts`:升级成功 + 一句通知、忙时不升、自检失败 ⇒ 退回(claude 改链接 / codex 改 `current` / cursor 两个链接)+ 记坏版本 + 只通知一次 + 坏版本不重试、出了更新的照常升、agy 退不回 ⇒ 手动步骤、自检暂缓不退回 30 分钟后补做、升级器失败退避、查最新失败退避、报错触发 + 去抖、每天一次、关掉、不并发、CLI 自己在后台升了 ⇒ 补自检 ⇒ 退回、手动退回。
- `src/core/cli-upgrade/pure.test.ts`:版本解析与比较、报错识别(含真机采集的 codex 原文)、配置、退避、查最新(注入 fetch)。
- `src/daemon/cli-upgrade/verify.test.ts`、`wire.test.ts`;`routes-daemon-control.test.ts`(路由 + health 块);`src/cli/agent-cli-status.test.ts`;`service-execution.test.ts`(工作台把错误通道交出去)。

## 已知限制

- Claude Code 自己的后台升级器很勤(一天一版),每次外面换了版本都会补一次自检(两轮对话 + 一个工作台任务)。这是「自动发现不兼容」的成本;嫌多可以 `per_cli.claude.enabled: false`。
- 退回之后,CLI 自带的后台升级器可能又把它升回那个坏版本;这时我们认得它(坏版本名单),直接再退回,通知不重复发。
- agy 没有只读的最新版本来源,也退不回;它的升级只能靠 `agy update` 自己。
- claude / agy 的「客户端太旧」报错句式是猜的,见上。
- Windows:三种「改链接」布局都是 POSIX 的,Windows 上退回大多走不通(Claude 仍可 `claude install <v>`)。升级与自检照常。
