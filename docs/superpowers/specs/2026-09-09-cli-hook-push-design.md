# 终端 CLI 事件推送到微信(CLI hook push)— Design

**Date**: 2026-09-09
**Status**: Implemented on `feat/cli-hook-push` 2026-09-09(单测 + CLI 冒烟过;真机 §8 待跑)
**Builds on**: A2A notify → 主人私聊(2026-05-24)、CC 桌宠 Phase B 权限卡(2026-09-05)、internal-api tier authz(2026-06-21)

## 1. 要解决什么

主人在终端 / 桌面里自己开的 `claude` 或 `codex` 会话,跑完一个长任务、或者停下来等批准时,
主人不在电脑前就不知道。wechat-cc 已经是主人随身的那条微信,所以这些事应该推到那里。

现状:daemon 自己拉起的 SDK 会话已经有权限卡(微信 y/n + 桌面卡片),但**主人自己开的终端
会话完全不在这条线上**。它们不是 daemon 的孩子,daemon 看不见。

## 2. 业内对照(决定「照抄什么」)

- Claude Code:Remote Control + Claude 手机 App 推送;hooks(Stop / Notification / UserPromptSubmit);
  channels(Telegram / Discord,研究预览)。
- Codex CLI(源码 2026-09-09 main):hooks 正式功能,默认开,12 个事件,含 Stop(带
  `last_assistant_message`)、PermissionRequest、UserPromptSubmit、SessionEnd;配置在
  `$CODEX_HOME/hooks.json`,形状与 Claude 的 settings.json `hooks` 相同(`{"hooks": {事件: [{matcher, hooks: [{type: "command", command, timeout, async}]}]}}`)。
  PermissionRequest hook 不回 decision ⇒ 走正常审批提示(core 测试 `assert_eq!(decision, None)`)。
- 社区通用:Stop hook → ntfy / Telegram。

结论:**两家都用 hooks 做出口**,消息进 daemon,daemon 决定发不发、怎么措辞,再走现有外发。

## 3. 架构

```
终端 claude ──Stop / Notification(permission_prompt) / UserPromptSubmit / SessionEnd──┐
                                                                                        │ 子进程:wechat-cc hook claude
终端 codex  ──Stop / PermissionRequest / UserPromptSubmit / SessionEnd─────────────────┤ 子进程:wechat-cc hook codex
                                                                                        ▼
                                                            POST /v1/cli/event(trusted,FILE token)
                                                                                        ▼
                                                     daemon: CliEventHub(core/cli-events.ts,纯逻辑)
                                                       · stop → 压 45 s 再发;同会话来 prompt 就撤
                                                       · permission → 压 20 s 再发;同会话任何后续事件都撤
                                                       · session_end → 清掉该会话的待发
                                                       · 措辞:来源 · 项目名 · 会话短码 · 事由 · 摘要
                                                                                        ▼
                                                     boot.sendAssistantText(主人 chat)—— 与 A2A notify 同一条外发
```

三条硬约束:

1. **hook 子命令永远 exit 0、永远不阻塞 CLI**:daemon 没跑 / 网络不通 / 400,一律静默;fetch 3 s 超时;
   两家的 hook 都配 `async: true`,CLI 不等我们。
2. **不回环**:daemon 自己经 SDK 拉起的 claude / codex 会继承 daemon 的环境,daemon 启动时置
   `WECHAT_CC_DAEMON_CHILD=1`;hook 子命令看到这个变量直接退出。否则 daemon 自己每个回合都会推回微信。
3. **断线不重试**:发送失败只记日志、丢弃(沿用「断线不要重试风暴」的规则);积压在 hub 里的只有定时器,
   没有队列。

## 4. 推送措辞(主人要一眼知道:哪个、哪个项目、要我干什么)

```
🔔 claude 完成了 · wechat-cc · 会话 a1b2c3
把 hook 子命令和安装器都接好了,测试 41 个全绿。

✋ codex 等你批准 · tendhearth · 会话 9f0e1d
Bash: rm -rf ./tmp
(回终端处理;这一类微信里暂时答不了)
```

- 项目名:`cwd` 对 `projects.list()` 里 path 的最长前缀命中 ⇒ alias;没命中 ⇒ cwd 末段目录名。
- 会话短码:`session_id` 前 6 位。
- 摘要:Stop 用 `last_assistant_message`(两家都有;Claude 文档明说别读 transcript,它会滞后),
  压成一行、最多 120 字;权限用 `工具名: 参数摘要`(codex 的 tool_input / claude 的 notification message)。

## 5. 去重(hook 不知道主人是否正坐在终端前)

- Stop 压 45 s:主人在场时 45 s 内多半会再输入 ⇒ UserPromptSubmit 撤销。
- **快问快答不推**:从 UserPromptSubmit 到 Stop 不足 90 s(`MIN_TURN_MS`)⇒ 主人多半还在屏幕前。
- **一次敲字最多推一条「完成了」**:推过之后、主人没再敲字,后面再多的 Stop(自动续跑、循环 tick、
  `ScheduleWakeup` 之类)都不是新消息,不推;主人敲一句就重新算。
- **harness 塞的 prompt 不算主人敲字**:`/loop …` 唤醒、`<task-notification>`、`<system-reminder>`
  也会触发 UserPromptSubmit,但主人并没回到键盘前 —— hook 侧标 `automated: true`,hub 对它不撤待发、
  不刷在场、不重置「已推过」。真机教训:2026-09-09 一个自跑的循环每个 tick 都推了一条。
- 权限提醒压 20 s;刚在微信里发过权限卡片(§6.3)的会话,60 s 内的提醒不重复推(卡片就是通知)。
  已知局限:主人在场答了、但工具跑超过 20 s 且没有后续 hook 事件 ⇒ 会多推一条。接受。
- **在场主信号是机器空闲**:hook 探本机上次键鼠输入距今几秒(macOS ioreg / Windows GetLastInputInfo /
  Linux xprintidle)随事件带上;daemon 发送时刻对本机会话再探一次。< 120 s ⇒ 人在电脑前 ⇒ 系统原生通知,
  不进微信(没有桌面面就不发);否则走微信。手机那头的活动**不是**信号:主人可能半天不回。
- **合并**:15 s 内多条会话先后完成合成一条。
- **看得全**:最后一句完整放(上限 1200 字,去 markdown 记号),更长的进 share_page 附「全文」链接。
- 每会话只留一个待发定时器;新事件替换旧的。最多跟踪 64 个会话,超过丢最旧的。

## 6. 接口

### 6.1 事件(hook → daemon)

```ts
interface CliEvent {
  source: 'claude' | 'codex'
  kind: 'stop' | 'prompt' | 'permission' | 'session_end'
  session_id: string        // 1..200
  cwd: string               // 1..1000
  text?: string             // ≤ 4000;stop 的最后一句 / permission 的工具摘要
}
```

`POST /v1/cli/event`,tier `trusted`(hook 读 `internal-api-info.json` 的 FILE token,与 `wechat-cc agent` 同源)。
响应 `{ ok: true, action: 'scheduled' | 'cancelled' | 'cleared' | 'noop' }`;hub 没接线 ⇒ 503。

### 6.3 权限中继:微信里替终端拍板(两家都有 `PermissionRequest` hook)

```
终端 claude / codex ── PermissionRequest hook(同步,150 s)── wechat-cc hook <source>
   ├─ POST /v1/cli/permission {source, session_id, cwd, tool_name, summary}
   │     daemon:主人最近 3 min(PRESENT_WINDOW_MS)在这条会话敲过字 ⇒ {status: owner_present}(终端自己问)
   │            否则 5 位随机码 + ilink.askUser(主人 chat, 卡片, 码, 120 s) ⇒ {status: pending, hash}
   ├─ GET /v1/cli/permission?hash&wait_ms(每次最多挂 25 s,hook 循环到 125 s)
   └─ allow / deny ⇒ stdout 写 {hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior}}}
      其他(owner_present / timeout / undelivered / daemon 没跑)⇒ 什么都不写,终端自己弹提示;
      顺手 POST 一条 kind=permission 的提醒(刚发过卡片的会被 daemon 压掉)
```

- 复用 `ilink.askUser` ⇒ 微信「y 码 / n 码」与桌宠权限卡都能拍板,只认主人 chat(`approverOf`)。
- 卡片措辞:`✋ codex 等你批准 · tendhearth · 会话 9f0e1d\nBash: rm -rf ./tmp\n回「y k3x9z」放行、「n k3x9z」拒绝;120 秒内有效,过期终端自己会问。`
- 「没见过这条会话的 prompt」(daemon 刚重启、hooks 刚装)按不在场处理:宁可让在场的主人多等一次
  (手机上答掉即可),也不漏掉真正走开的那次。
- 登记 + 轮询而不是一次长连接:hook 子进程自己掐总时限,不依赖 HTTP 空闲超时的默契。

### 6.4 主人在微信里对会话说话:「看 码」「@码 文本」

- 会话码 = session_id 前 6 位,推送里都带。hub 登记见过的会话(source / cwd / 机器 / transcript 路径),
  按前缀找,最近的优先。只认主人 chat;别人发这两种句式当普通消息。
- **看 码**:读 transcript 尾巴(Claude jsonl / Codex rollout jsonl,只取对话文字,跳过工具、思考、
  harness 塞的东西),渲染成 markdown → share_page → 回链接;页面生成失败就内联前 1200 字。
- **@码 文本**:`claude -p --resume <id> <文本>` / `codex exec --skip-git-repo-check resume <id> <文本>`,
  在原 cwd 起新进程接着原对话跑(daemon 的 --dangerously 姿态原样带过去,非交互模式没人能点允许);
  先回「接着跑」,跑完把输出回微信(超长走 share_page),期间登记 busy 免得空闲自重启掐断;10 分钟上限。
  新进程继承 daemon 环境(WECHAT_CC_DAEMON_CHILD=1)⇒ 它自己的 hooks 静默,不会再推一次「完成了」。
  已知代价:终端 TUI 若还开着,两个进程共用一份记录 —— 回复里不提醒,主人回终端时 Claude 自己会说。
- 那边(别的机器)的会话:v1 回「这台机接不上」,转发见 §6.5。

### 6.5 这边 / 那边(一脑多手)

```
手(没有微信)                                            脑(绑微信)
 hook → 本机 daemon ── 有能叫回去的脑? ──是──→ POST <脑>/a2a/cli/event      → 脑的 hub(machine=手名,origin_agent=手 id)
                          │                     POST <脑>/a2a/cli/permission → 脑的权限中继(微信卡片写「那边(手)」)
                          │                     POST 同路径带 hash           → 轮询状态
                          否 → 本机照旧
 人就在这只手前(idle_s 小)→ 本机桌面通知 / 终端自己问,不惊动脑(脑够不着这块屏幕)
 「看 / @」那边的会话 ←── 脑 POST <手>/a2a/cli/reply(派活钥匙,may_exec 门)──  看:手回 markdown,脑做页面
                                                                                说:手起 resume,跑完 POST <脑>/a2a/notify 送回(主人看到 [A2A:手] …)
```

- **配对时把「怎么叫回脑」交给手**:`hand join` 的 /a2a/pair 多带 `brain_url`(脑的 a2a-info.json)与
  `callback_key`(脑侧那条手记录的 inbound key);手把它们存在脑记录的 url / outbound_api_key 上。
  老脑不带 ⇒ 手记录仍是 `unused` 哨兵,只能被派活。**已有的手要重新 `hand join` 一次**才有回叫。
- 手侧判「有没有脑」:registry 里 may_exec、url 不是占位、outbound_api_key 不是 'unused' 的那条。
- 脑侧 origin_agent 只认已验证的 Bearer 身份,永远不信 body 里写的。
### 6.2 CLI

- `wechat-cc hook claude` / `wechat-cc hook codex`:从 stdin 读 hook JSON,归一化后 POST;永远 exit 0。
- `wechat-cc hook install [--claude] [--codex]`(缺省两家都装):幂等写入
  `~/.claude/settings.json` 的 `hooks` 与 `$CODEX_HOME/hooks.json`(缺省 `~/.codex/hooks.json`)。
  只动带 `wechat-cc` 标记的条目,别人的 hook 原样保留。命令行用当前可执行文件的绝对路径
  (源码模式 `bun cli.ts hook claude`,编译包 `wechat-cc-cli hook claude`),与 MCP stdio spec 同一套判断。
- `wechat-cc hook uninstall`:只删自己的条目。
- 命令行统一写成 `"<可执行文件>" ["<cli.ts>"] hook <source>`(双引号包路径)。Claude Code 的 hook 在所有平台
  走 bash(Windows 上是 Git Bash;`shell: powershell` 是逐条 opt-in,我们不用);Codex 在 Windows 走
  `cmd.exe /C`(源码 `command_runner.rs` 读 COMSPEC)—— 两边都认这个写法。不写 `commandWindows`。
- `wechat-cc doctor` 不并入 hook 状态:桌面端解析 doctor JSON,加字段不值得冒险;`hook status` 已够。
- `wechat-cc hook status`:两家各自装没装、命令行是什么。

## 7. 非目标(本轮不做)

- 微信消息进终端会话(Claude channels / Codex app-server steer)。
- 桌宠对终端会话的感知(PetSignals 加 hook 入口)。
- 参与者能力矩阵的抽象升级(见对话 2026-09-09 的「统一架构」讨论)。

## 8. 验收

- 单测:hub 的压/撤/清/替换/上限;措辞;项目名解析;两家 payload 归一化;安装器幂等与不动他人条目;路由 tier + schema。
- 真机:本机 `wechat-cc hook install` 后,在终端跑一个超过 90 s 的任务,Stop 后 45 s 微信收到一条;期间再敲一句则不收。
  daemon 自己的回合不推(回环守卫)。权限:3 分钟没敲字后触发一次需要批准的工具,微信收到卡片,回「y 码」终端放行。
- 已在真机 daemon(自重启到本分支)上验过:`/v1/cli/event` 压/撤/清、`/v1/cli/permission` 在场短路与轮询状态。
