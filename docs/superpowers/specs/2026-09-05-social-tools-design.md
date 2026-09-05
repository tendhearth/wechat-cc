# 社交工具面:让伙伴自己会用社交层(2026-09-05)

上游:`2026-09-04-social-architecture-rethink.md`(五层)、`2026-09-04-wish-postcard-design.md`(一跳)、`2026-09-04-introduction-design.md`(二跳)。
背景判断:社交层的协议、幂等、身份都是确定性代码,这是对的;不够 AI native 的地方在**入口** —— 主人得背「派 w1」「认识 ab12」这种 hex 引用,因为模型手里没有工具。这轮只补工具面,第 2 项「伙伴日程判断」另开 spec。

## 0. 这轮要解决的事

主人对伙伴说「帮我看看有谁回了心愿」「把那个爬山的认识一下」「有人想认识我吗」「去串个门」,伙伴自己查、自己做、自己回话,不需要主人记任何编号。已有的精确命令(「派 w1」「认识 ab12」「串门」「6 位配对码」)一字不改,继续当快车道。

owner 拍板(2026-09-05):
- **说了就做**:认识 / 同意 / 不了 / 串门,主人这句话本身就是指令,模型直接调工具并回报结果。只有**派心愿**保留「先出脱敏预览、主人点头才发」,因为它过披露门;点头可以是自然语言(「发吧」),模型再调 `wish_send`。
- **正则只留精确形式当快车道,其余全走模型**:不加便宜模型意图分类层,不拆正则。

## 1. 工具面

全部加在现有的 `wechat` MCP server(`src/mcp-servers/wechat/`),内部打 internal API(trusted 路由),因此所有 provider 自动拿到(claude / codex / cursor / gemini / agy 走各自的 MCP 接法,openai 自建 loop 走 `openai-mcp-bridge`)。

| 工具 | 输入 | 打的路由 | 返回(JSON 原样) |
|---|---|---|---|
| `wish_list` | 无 | `GET /v1/social/wishes` | `{ wishes:[{ id, text, status, created_at, expires_at, sent_to, replies, postcards?:[{ reply_id, via_label, preview, at, requested }] }] }` |
| `social_seek` | `topic, city?` | `POST /v1/social/wish`(不变) | `{ ok, id, preview }` 或 `{ ok:false, error, violations }`;工具描述要求把 preview **原样**转述、等主人点头 |
| `wish_send` | `ref`(id 或前缀) | `POST /v1/social/wish/send {id}` | 路由原样(`ok` 或 `ok:false, reason`) |
| `wish_cancel` | `ref` | `POST /v1/social/wish/cancel {id}` | 路由原样 |
| `intro_request` | `reply_ref` | `POST /v1/social/intro/request {reply_id}` | `{ ok:true, reply_id }` 或 `{ ok:false, reason }` |
| `intro_accept` | `reply_ref` | `POST /v1/social/intro/accept {reply_id}` | 同上 |
| `intro_decline` | `reply_ref` | `POST /v1/social/intro/decline {reply_id}` | 同上 |
| `intro_offers` | 无 | `GET /v1/social/intro/offers` | `{ offers:[{ reply_id, hint, via_label, at }] }` |
| `relationships` | 无 | `GET /v1/social/relationships` | 路由原样(关系视图,含 label / kind / origin / familiarity) |
| `visit` | `target?` | `POST /v1/social/visit {target?}` | `{ ok:true, started:true }` 或 `{ ok:false, reason }` |

规则:
- **工具不返回文案**,只返回 JSON(`ok / reason / 数据`),回话由模型组织。command-router 里那套中文只服务精确快车道,两边不共享字符串。唯一例外是心愿预览:`social_seek` 描述里要求原样转述 preview(现状保留)。
- **引用解析是模型的活**:「那个爬山的」→ 先 `wish_list`,在 `postcards[].preview` 里对上,再拿 `reply_id` 调 `intro_request`。工具描述里写明这个两步用法;`requested:true` 的明信片要告诉主人「已经在问了」而不是再点一次。
- `ref` / `reply_ref` 接受完整 id 或前缀(≥ 2 位),服务端已做前缀匹配并返回 `not_found` / `ambiguous`;模型收到 `ambiguous` 时列候选让主人选。
- 503 `social_not_wired` / 网络错误走 `passthroughErrorResult`,模型据此说「社交没开」或「daemon 没起」(两句要分开,这是心愿那轮留下的 minor,顺手在描述里区分)。
- **不做成工具的**:配对码(`parsePairCommand`)、访客 allow / deny / invite(`parseGuestCommand`)、回信(`parseLetterCommand`)。前两个是安全敏感的精确指令,回信这轮不动。

文件:`src/mcp-servers/wechat/tools-social.ts` 从 53 行长到约 200 行仍是一个文件(同一 domain,同一 client);导出一个 `registerSocialTools(server, client)` 把十个工具一起注册,`registerSocialSeekTool` 保留为其中一个函数以免动 main.ts 之外的引用。

## 2. 入口顺序

`pipeline-deps.ts` 里 `commandRouter.tryHandle(msg)` → 否则 `coordinator.dispatch(msg)` 的顺序**不变**。六个 `parse*Command` 的正则都已锚定精确形式(`^派\s+<ref>$`、`^(认识|同意|不了)\s+#?<hex>$`、`^(串门|去串门|…)$`、6 位码),不匹配的文本本来就落到模型。所以入口层没有代码改动;缺的是下面这段能力说明。

## 3. 系统提示

`prompt-builder.ts` 新增 `socialAvailable?: boolean`,与 `knowledgeSearchAvailable` 同一契约:缺省 false 时输出**逐字节不变**;为 true 时在工具区加一段「社交」能力说明:

```
- **替主人交朋友**(`wish_list` / `social_seek` / `wish_send` / `wish_cancel` / `intro_request` / `intro_accept` / `intro_decline` / `intro_offers` / `relationships` / `visit`):
  主人问「谁回了心愿」「有人想认识我吗」「我都认识谁」先查再答;主人说「把 X 认识一下」「同意 / 不了」「去串门」就直接做,做完把结果说清楚。
  派心愿例外:`social_seek` 只出脱敏预览,把 preview 原样念给主人,主人点头(任何肯定的说法)再 `wish_send`。
  引用靠 `wish_list` 里的 preview 对人,对不上或有多张就列出来问。
```

`bootstrap/index.ts` 计算:`socialAvailable: !!boot.social && tierProfile.allow.has('social_act')`(和 L809 `knowledgeSearchAvailable` 并排)。社交层没接线(`social` 为 undefined)时不加这段,模型不会去调不存在的工具。

## 4. 权限

`user-tier.ts`:
- 新增 `ToolKind` `'social_act'`,加入 `ADMIN_ONLY`;`classifyToolUse` 把 `wish_list / wish_send / wish_cancel / intro_request / intro_accept / intro_decline / intro_offers / relationships / visit` 映射到 `social_act`;`social_seek` 保持原 kind 不动。
- `main.ts` 里这十个工具只在 `SESSION_IS_ADMIN` 分支注册(和 `registerSocialSeekTool` 同一处),非 admin 会话看不到;路由层再拒一次非 admin token。三层:注册、classify、路由。

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `src/mcp-servers/wechat/tools-social.ts` | 九个新工具 + `registerSocialTools` |
| `src/mcp-servers/wechat/main.ts` | admin 分支改调 `registerSocialTools` |
| `src/core/user-tier.ts` | `social_act` kind、ADMIN_ONLY、classify 映射 |
| `src/core/prompt-builder.ts` | `socialAvailable` + 社交能力段 |
| `src/daemon/bootstrap/index.ts` | 计算并传 `socialAvailable` |
| 测试 | `tools-social.test.ts`(新)、`user-tier.test.ts`、`prompt-builder.test.ts`、`integration.test.ts` |

不动:command-router 及其六个 parser 与测试、桌面、路由、wire-*。

## 6. 测试

- `tools-social.test.ts`(新):用 `InMemoryTransport` 起 `McpServer` + fake `InternalApiClient`(记录 `(method, path, body)`,按路径返回夹具)。每个工具一条:调用参数 → 打对路由 + body 形状 → 返回的 `content[0].text` 是路由 JSON 原样;`intro_request('ab')` 打 `{reply_id:'ab'}`;路由 503 → `passthroughErrorResult` 文本含 `social_not_wired`;`visit()` 不带 target 时 body 为 `{}`。
- `user-tier.test.ts`:九个 `mcp__wechat__<name>` → `social_act`;admin allow、trusted / guest deny;`social_seek` 映射不变。
- `prompt-builder.test.ts`:`socialAvailable` 缺省时输出与之前逐字节相同(照 `knowledgeSearchAvailable` 的那条);为 true 时含「替主人交朋友」与十个工具名。
- `integration.test.ts`:admin 会话 `tools/list` 含 `wish_list` 与 `intro_request`;非 admin 会话不含(照现有那条 admin-only 断言追加)。
- command-router 的既有测试全部不改,证明快车道原样。

真机验收(两台配对后):微信里对伙伴说「帮我看看有谁回了心愿」→ 伙伴列出回音;有 hop 2 回音时说「把那个 X 的认识一下」→ 对端主人收到「想认识你」;对端说「同意」(不带编号)→ 双方互见为 peer。

## 7. 明确不做 / 待办

- 不加便宜模型意图分类层;不拆正则;不改桌面;不做回信工具。
- 文案集中化(微信 / 桌面 / 工具三处)不在这轮;工具面本身就是「文案由模型组织」的第一步。
- 第 2 项「伙伴日程判断」(把「今天要不要派心愿 / 去串门」交给模型)另开 spec,在这轮合入后 brainstorm。
