# PR 5：App 回复来源圆标

工作区 `wt-who-answers-app`；分支 `who-answers-app-avatar`；基线 `087dbf9f8`。只改原生 App 与本记录，不 commit；整合者负责 verify、mini 验收与提交。已执行指定文件的 `git add`，但沙盒拒绝创建 `.git/worktrees/wt-who-answers-app/index.lock`（Operation not permitted），故改动全部保留在工作区，**未暂存**；整合者需补暂存。

## 改了哪

- 数据已齐：`backend/types.ts` 从协议推导 `ChatMessageT` / `MatterDetailT`；`live.ts` 经真实 schema 读取 page、window、events、work 和事项详情，均保留来源，无需修改 daemon／协议。
- `view/chat.ts`、`view/conversation.ts`、`state/useChat.ts`：补齐气泡、事项文本事件和锚点历史投影的归属；顶层归属优先于旧的 replyExtras。
- `ui/ConversationScreen.tsx`：历史气泡、实时 agent_message、带回结果、纯附件回复接入逐条来源；普通消息保留微信／电脑／手机渠道文字，执行者的过程／结果不再重复署名 CC。
- `app/matter/[id]/index.tsx`：最近结果和早前过程回复共用圆标；名称同主对话读 `backend.chatModel()`（`/v1/matter/owner-chat/model` 的 providers），不取当前执行者或 matter.agentNames 猜来源。
- 新增 `view/reply-speaker.ts`、`ui/ReplySpeaker.tsx`：严格限定 role=cc、speaker=agent、非空字符串 provider；复用 `AgentAvatars.tsx` 的 `AgentAvatar`。openai／未知服务走既有通用首字符圆标；名称读取失败退回 provider id；提供 image 读屏名称，无常驻厂商文字。圆标表与资产未改。
- CC、通知、主人和缺来源旧消息沿原展示；不从 model、当前后端或 replyParts 推断整条回复来源，与网页门槛一致。

## 测了哪

新增 **10 个用例**，只增不减：`view/chat.test.ts`、`view/conversation.test.ts`、`state/useChat.status.test.ts`、`state/chat-feedback.test.ts`、`view/matter-disclosure-screen.test.ts`、`backend/live.test.ts`。覆盖两棒接力、锚点分页刷新、真实 schema 的 m/v1 读取、实时／结果／纯附件、通用服务标、设置名称及失败回退、读屏、CC／通知／旧记录与渠道信息。

红／绿：实现前运行前五个测试文件，**7 失败、67 通过**；失败均为缺失来源投影／圆标。实现后最终相关回归 **16 文件、238 用例通过**：

```sh
cd apps/app
bun --bun vitest run src/backend/live.test.ts src/view/chat.test.ts src/view/conversation.test.ts src/view/conversation-work.test.ts src/state/useChat.status.test.ts src/state/chat-feedback.test.ts src/view/matter-disclosure-screen.test.ts src/view/matter-terminal-screen.test.ts src/ui/ReplyExtras.reading.test.ts src/ui/MatterRow.test.ts src/ui/style.guard.test.ts src/ui/app-shell.test.ts src/ui/minimal-shell.test.ts src/ui/component-appearance.test.ts src/i18n/i18n.test.ts src/view/agents.test.ts --maxWorkers=1
bun run typecheck
```

根目录 `bun x tsc --noEmit` 通过；`bun run depcheck` 0 错误、16 条既有 CLI→daemon 警告；以下 **7 守卫文件、48 用例通过**；`git diff --check` 通过。

```sh
bun --bun vitest run scripts/mock-internal.guard.test.ts scripts/link-routes-from-source.guard.test.ts scripts/client-paths.guard.test.ts scripts/executor-display-names.guard.test.ts scripts/component-appearance.guard.test.ts scripts/design-tokens.guard.test.ts scripts/protocol-purity.guard.test.ts --maxWorkers=1
```

## mini 与整合者待验

未运行完整 `bun run verify`、真实形状沙盒、原生构建、模拟器、Playwright、截图或真模型双跑；主 Mac 禁重型／UI 测试，沙盒不能 listen，留整合者在适当环境执行。全部已运行测试仅用离线假后端／假协议，无监听或真实 daemon。

mini 用离线同形消息回放：Claude→Codex 两棒，在主对话、事项最近／早前回复和带回结果各只露实际一家；退出详情、重连、翻页、切当前后端后旧圆标不变；openai 即使 model=Claude 仍为通用标，读屏读设置名称，名称接口失败读 id；CC／通知／旧记录不添执行者标；窄屏、大字体、纯附件和展开过程无挤压／重复标。只用测试工作区与假服务，不带生产数据、凭据或真实模型。设计稿要求的 Claude／网关双跑由整合者另在有网络守护的主机隔离串行执行，本次未验。
