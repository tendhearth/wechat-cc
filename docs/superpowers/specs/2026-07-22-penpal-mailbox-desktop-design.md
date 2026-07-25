# 笔友信箱(后端 penpal 路由 + 觅食台信箱区块)设计

**日期**: 2026-07-22
**状态**: 已批准(方案 A:4 条细路由,读 admin / 发信 trusted)
**父级脉络**: `2026-07-18-anonymous-penpal-social-layer-design.md`(A/B 笔友栈)、`2026-07-22-forage-desk-pairing-seek-ui-design.md`(P3.5,信箱明确排除待本期)

## 背景与目标

笔友信已在后端完整落地(`penpal_channel`/`penpal_letter`,明文 `plaintext`+`read_at` 列专为 owner 阅读设计;`boot.penpal.sendLetter` 已被微信「回信 <channel> <text>」消费),但 internal-api 没有任何读/写暴露——桌面看不到信。本期:**4 条 penpal 路由 + 觅食台新增 ✉️ 信箱区块**(看信 + 回信 + 未读角标)。

## 范围内 / 外

- 内:store 两个小查询、boot/InternalApiDeps 暴露、`routes-penpal.ts`、route-tiers 定级(含发布评审旗)、觅食台信箱 UI、模块/路由测试。
- 外(YAGNI,后补):断交/关闭信道;桌面实时推送(维持刷新/进页拉取,新信提醒仍走微信 notifyInbound);CLI 回信入口(本期 trusted 定级已为它铺路,但不实现)。

## 后端

### 1. LetterStore 扩展(`src/core/penpal-letter-store.ts`)

- `unreadCountByChannel(): Array<{ channel_id: string; n: number }>` —— `SELECT channel_id, COUNT(*) AS n FROM penpal_letter WHERE direction='in' AND read_at IS NULL GROUP BY channel_id`。
- `markAllRead(channelId: string, at: string): void` —— `UPDATE penpal_letter SET read_at=? WHERE channel_id=? AND direction='in' AND read_at IS NULL`。

### 2. 暴露面

- `boot.penpal` 从 `{ sendLetter }` 扩为 `{ sendLetter, channelStore, letterStore }`(wire-social 组装处已同时持有两个 store)。线索标题用 `boot.social.seekStore`(已暴露)按 `seek_id` 查 topic。
- `InternalApiDeps.penpal` 同步扩展;未接线(无 mailbox/social 配置)保持 `undefined` → 路由 503 `penpal_not_wired`,与 `social_not_wired` 同款 fail-closed 姿势。

### 3. 路由(`src/daemon/internal-api/routes-penpal.ts`,新文件,镜像 routes-social.ts;inline 校验,无 REQUEST_SCHEMAS)

| 路由 | 级别 | 语义 |
|---|---|---|
| `GET /v1/penpal/channels` | admin | `status='open'` 信道列表,每条 `{id, title, peer_label, degree, unread, last_preview, last_at}`。`title` = seekStore 查 `seek_id` 的 topic(查不到→`''`);`peer_label` = 直连(`peer_agent_id` 非空)→ registry 里该 agent 的 name(查不到→agent_id),中转→`第${degree}度笔友`;`unread` 来自 unreadCountByChannel;`last_preview/last_at` = 该信道最近一封的 plaintext 截断 60 字 + created_at(无信→null)。 |
| `GET /v1/penpal/letters?channel_id=` | admin | 该信道全部信件的 **owner 投影**:`{id, direction, plaintext, created_at, read_at}`。**密文字段(sealed_ciphertext/nonce/tag)绝不进响应**(UI 用不着,最小暴露;测试断言)。channel 不存在→404 `unknown_channel`。 |
| `POST /v1/penpal/letters` | **trusted** | body `{channel_id, text}`(均非空 string,否则 400)→ `boot.penpal.sendLetter` 透传 `{ok, error?}`。 |
| `POST /v1/penpal/letters/read` | admin | body `{channel_id}` → `markAllRead(channel_id, now)` → `{ok:true}`(幂等,不存在的 channel 也 ok)。 |

**定级评审(发布时 surface,旗子写进 route-tiers.ts 注释)**:发信 trusted 的理由与 reveal/`a2a/send` 先例一致——作用于**已建立**的匿名笔友关系(信道已 open,身份已互揭),不产生新广播/新关系;localhost-only internal-api + 0600 文件 token 模型下可接受;顺带解锁未来 CLI 回信。读路由 admin(P2 seeks/echoes 读路由先例,桌面 token 是 admin)。

### 4. registry 名字查询

`peer_label` 需要 agent name:InternalApiDeps 已有 a2a registry 可查(routes-a2a.ts 同款来源);按 `peer_agent_id` 取 name,失败回退 agent_id 原文。

## 桌面(觅食台 §② 明信片之下新增区块)

- `index.html`:§②之后加 `<section class="fd-section" id="fd-mailbox-sec">`,头部「✉️ 笔友信箱」+ `#fd-mailbox-count` 总未读角标 + `#fd-mailbox` 容器。
- `refresh()` 的 `Promise.all` 增加 `GET /v1/penpal/channels`(`.catch(()=>null)`;null → 区块显示未启用/为空的引导)。
- **信道卡片**(`renderMailbox`):线索标题、`peer_label`、`degree`、未读 badge、`last_preview`。点击卡片展开**线程视图**:
  - 拉 `GET /v1/penpal/letters?channel_id=` 渲染气泡(in 左 / out 右,时间用现有 `fdRelTime`),随即调 `POST letters/read` 清未读并本地清 badge;
  - 底部回信输入 + 发送按钮:`POST /v1/penpal/letters`,pending 禁用,成功→乐观追加气泡+清输入,失败→恢复可点+错误文案(`channel_not_open`/`no_route`/`send_failed`/网络 各自人话)。
  - 再点卡片头收起线程。同时只展开一个信道(切换收起旧的)。
- 空状态:「还没有笔友——等一张明信片揭晓牵线后,就能在这里通信了。」;503/未接线 → `wechat-cc social enable` 引导(复用现有文案函数模式)。
- 纪律沿用 P3/P3.5 全套:`fd-` 类名、`escapeHtml` 全插值、委托监听 + 鸭子守卫、`__xxxForTest` 测试缝、`initA2AAgentsTab`/`refresh` 签名不变、main.js 不动。

## 错误处理

- 所有 UI 网络分支非崩溃(P3 reveal 四分支模式);按钮 pending 防双击。
- 路由层:缺参 400;未接线 503;未知 channel 404(letters)/静默 ok(read,幂等)。

## 测试

- store:两个新查询的行为(未读计数分组、markAllRead 只动 inbound 未读行)。
- 路由(`routes-penpal.test.ts` 镜像 routes-social.test.ts):503 未接线;channels 的 title/peer_label/unread 组装;letters 投影**不含密文字段**(断言);send 透传;read 幂等;tier 断言(route-tiers.test.ts 加 4 条)。
- 桌面模块测试(a2a-agents.test.ts 续写):信道卡渲染(含未读 badge)、展开线程渲染 in/out、展开触发 read、回信成功乐观追加/失败恢复、空态、503 引导。
- 全仓回归。

## 非目标

见"范围内/外"。另:不改微信「回信」路径、不改 correspondent/传输层——本期纯粹是已有能力的暴露与呈现。
