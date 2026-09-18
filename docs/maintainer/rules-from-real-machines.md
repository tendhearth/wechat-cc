# 真机抓到的规矩

下面每一条都是**单测没抓到、真机抓到**的。写相关代码前先扫一眼。

## 协议 / 外部 CLI

- **MCP 的 `structuredContent` 只能含 `outputSchema` 里声明过的键。** 多一个键,严格的客户端(cursor-agent)就回 `-32602`,模型看不懂错误于是原地重试,一直转圈。wechat MCP 的 `ping` 就这么栽过。
- **ACP 的 `initialize` 结果里,`promptCapabilities` 嵌在 `agentCapabilities` 下面**(`result.agentCapabilities.promptCapabilities.image`),不是平铺在 `result` 上。2026-09-18 照文档写的那版就取空了。
- **凡是照协议文档写的字段路径,先去录到的报文里对一遍。** 仓库里有真机报文:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`,回放契约测试 `src/core/acp/fixtures.test.ts`。
- ACP 的 `toolCallId` 里会嵌**字面换行**;拿它当 DOM id / event key 之前一律过 `acpActivityId()`。
- ACP 的 `agent_message_chunk` **一条 `messageId` 都没有**;同一轮里工具调用前后是两条助理消息,itemId 只能自己合成。
- 外部 CLI 的 MCP 命名空间各家不同(agy 的 server 名带命名空间前缀,cursor 的 envelope 形状完全是另一套);别假设「就叫 `wechat`」,用 `normalizeWechatMcpServer` 折回规范名。
- **版本号判不出能不能用。** 别按 CLI 版本号拒绝注册某个执行者,用用户自己装的 CLI + 首次使用时真探测。

## 进程与超时

- **provider 的超时必须短于服务层的超时**,否则精确的错误永远到不了调用方,调用方只会拿到一个笼统的「超时」:spawn 45s < 60s,close 2.5s < 3s。
- **`close()` 要确认进程组真的没了。** 关 stdin 不会让 `cursor-agent` 退出。
- **daemon 里的后台长任务必须持 `holdBusy` token**,否则空闲自动重启会在它干到一半时把它踢掉。
- 断线 / 网络不稳时停掉外发与 LLM 轮次,重试退避必须是**指数级**(微信风控)。

## 路由登记

新加一条内部 API 路由:

- **桌面 app 会调** ⇒ 要登记**五处**:`src/daemon/internal-api/route-tiers.ts`、`token-registry.ts` 的 `routeAllow` **以及它那个精确集合测试**、`apps/desktop/src-tauri/src/lib.rs` 的 `matches!` **以及它的测试表**、`apps/desktop/workbench-proxy.ts`。
- **桌面不调** ⇒ 登记**三处**(route-tiers + token-registry + 它的精确集合测试)。

漏一处的典型症状是按钮按下去 403 `route_not_allowed`,而且只在打包版上出现。

## 对话侧

- **对话侧的 solo 协调器,每收到一条 `text` 事件就发一条微信。** 所以流式 provider 必须按「一条助理消息」攒完再吐一条 text,否则主人收到几十条碎片。ACP 翻译器的 `text: 'messages'` 模式就是干这个的。
- 旁听 ≠ 改道:别让旁路的事件把回复通道抢走。

## 跨平台盲区

- **`bun:sqlite` 的 URI 打开方式、`bun:test` 的 import**:在 Mac 上看着好好的,在 node / Windows 上要么炸要么根本没跑过。本地复现:`npm run test:node`。运行时相关的东西一律走 `src/lib/runtime/*` 适配层。
- Windows 真机抓到过两个真 bug:`STATE_DIR` 环境变量名在两处写法分裂;`account.json` 不容忍 BOM。读配置文件时把 BOM 剥掉。
- Windows / 微信侧目前**没有免审确认入口** —— 需要主人确认的流程在那两个面上是断的,设计时要知道。

## 报告与日志

- **永远不要把 token 打进日志或报告**。要证明读到了,就贴长度或哈希前 8 位。
- 真机脚本 / fixture 进仓库前脱敏:用户名 ⇒ `owner`,会话 token ⇒ `<redacted>`。进仓库后 `rg -n "<你的用户名>" <路径>` 必须是空的。
