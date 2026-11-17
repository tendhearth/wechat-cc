# 管家的屋子 · 第 3 步:App 名单条 + 直通页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App 主对话页头下多一条「在做」名单条,点一个头像推进那件事的直通页,在直通页底部直接对那家 agent 说话;撤掉话题行与「N 件事等你」。

**Architecture:** 名单只读 daemon 的 `GET /v1/roster`(设备令牌,第 1 步 #960),订阅 hub 主题 `roster` 后重拉。直通页就是现有 `matter/[id]` 与 `terminal/[id]`,换页头、把 `SayBar → /compose` 换成内联输入框;说话逻辑从 `compose.tsx` 抽成 hook 共用,`/compose?matter=` 保留给带附件的情况(输入框左边 ＋ 进去)。

**Tech Stack:** Expo / React Native,TypeScript,vitest(view / state 层),Maestro(只在 mini 跑)。

**Spec:** `docs/superpowers/specs/2026-11-17-butler-layout-design.md` §4.3、§4.4;示意图 https://claude.ai/artifact/Dv64iDG3X8WsyLbPJZfh6x(手机两张)

## Global Constraints

- 状态词 / 分组标题只查协议包 `STATUS_TABLE` / `HOME_GROUP_WORDS`;按钮词按 `docs/reference/phone-wording.md`。
- 名单条:只放 waiting + working,最多 5 个;末尾「在做 N ›」N = 三组总数;三组都空时整行不渲染(不占高度)。等你的头像描边 accent 2px,其余 hair 1px;多棒叠两枚(当前棒在前、大一号)。
- 触区 ≥ 44pt;只用 `componentAppearance` / tokens,不新增颜色。
- 直通页页头:「‹ CC」返回 + 当前棒圆标 + 事名 + 小字「项目 · 第 i 棒 / n」;多棒时下面一行接力条。
- 直通输入框 placeholder「对 <名字> 说…」;终端事 / 会话发 `cli/session-say`,任务事发 `matter/say`(既有 `backend.say`,带 requestId 回执)。
- `homeView`(`view/home.ts`)暂时保留给「全部」/ 搜索结果用,主页不再调用它;删除它另立 PR。
- Maestro 与模拟器只在 mini 跑;主 Mac 只跑 `bun run verify`。

## Review Focus

1. 离线(够不着电脑)时名单条:不显示旧的等你描边,整行显示上次名单 + 页头已有的离线提示;不能把旧的等你当成现在的 —— Task 2 用例。
2. 直通页发出后网络断:输入框保留原文、显示「结果待核对」,恢复后按 requestId 查回执,不重复发 —— Task 3 用例(沿用 compose 的回执逻辑)。
3. 多棒事在直通页时接力换棒:页头圆标与 placeholder 换成新的当前棒,已写未发的草稿不丢 —— Task 3 用例。
4. 从推送通知直接打开直通页(冷启动):返回键回到对话而不是退出 App —— Task 3 用例(router 栈)。
5. 名单里的终端会话(没挂进事)点开:进 `terminal/[id]`,页头同样是「在跟 Claude Code 说 · <项目>」 —— Task 3 用例。

---

### Task 1: backend 与 hook

**Files:**
- Modify: `apps/app/src/backend/types.ts`(`Backend.roster?(signal?): Promise<RosterResponseT>`)、`backend/live.ts`(`api.roster.get` 走 `PHONE_CALLS.roster.get`)、demo backend(给一份固定名单:等你 1、在做 2(含一件多棒)、带回来的 1)
- Create: `apps/app/src/state/roster.ts`(`useRoster(): { items: RosterItemT[]; stale: boolean; error?: unknown; refresh(): Promise<void> }`,`useQuery('roster', …)` + `backend.subscribe('roster', refresh)`)
- Test: `apps/app/src/state/roster.test.ts`

- [ ] Step 1: 失败用例:订阅到 `roster` 事件就重拉;接口抛错保留上一份并 `stale:true`;demo 名单形状能过 `RosterResponse.parse`。
- [ ] Step 2–4: 实现,`bunx vitest run src/state/roster.test.ts`(在 apps/app 下)绿。
- [ ] Step 5: commit `App:名单读取与订阅`

### Task 2: 名单条 + 名单 sheet

**Files:**
- Create: `apps/app/src/ui/RosterStrip.tsx`、`apps/app/src/view/roster-strip.ts`(纯函数:`stripView(items, opts:{known:boolean}): { avatars: Array<{key;agents;waiting:boolean;current:string;label:string}>; total:number }`)、`apps/app/src/view/roster-strip.test.ts`
- Create: `apps/app/src/app/roster.tsx`(底部 sheet 式页面:三组,行复用 `MatterRow` 的样式;点行 → 直通页)
- Modify: `apps/app/src/ui/ConversationScreen.tsx`(TopBar 下挂 `RosterStrip`;删 `TopicRow` 与 `conversation-waiting` 定位器及其 state)
- Modify: `apps/app/src/app/memory.tsx`(顶部加一行「话题 ›」进现有 `/topics`)

- [ ] Step 1: `roster-strip.test.ts` 失败用例:只取 waiting + working、最多 5;total 含 back;waiting 标记;多棒 current 在前;`known:false` ⇒ 不标 waiting(Review Focus 1);全空 ⇒ `avatars:[]`、`total:0`。
- [ ] Step 2–4: 实现并绿;`view/conversation-work.test.ts`、`view/home.test.ts` 不新增红。
- [ ] Step 5: commit `App:名单条与名单页,话题挪进记忆`

### Task 3: 直通页

**Files:**
- Create: `apps/app/src/state/matter-say.ts`(从 `app/compose.tsx` 抽出:requestId 生成、发送、回执核对、草稿保存;`useMatterSay(target: {kind:'matter';id:string}|{kind:'terminal';sessionId:string})`)
- Create: `apps/app/src/ui/DirectHeader.tsx`、`apps/app/src/ui/DirectComposer.tsx`
- Modify: `apps/app/src/app/compose.tsx`(改用 `useMatterSay`,行为不变)
- Modify: `apps/app/src/app/matter/[id]/index.tsx`(页头换 `DirectHeader`;`SayBar` 换 `DirectComposer`,＋ 进 `/compose?matter=`)
- Modify: `apps/app/src/app/terminal/[id].tsx` / `ui/TerminalDetail.tsx`(同样的页头与输入框)
- Test: `apps/app/src/state/matter-say.test.ts`、`apps/app/src/view/direct-header.test.ts`(纯函数 `directHeaderView(detail|session, lang)`)

- [ ] Step 1: 失败用例:Review Focus 2、3、5;`compose.tsx` 原有用例照绿。
- [ ] Step 2–4: 实现并绿。
- [ ] Step 5: commit `App:直通页——页头露当前那一家,底部直接说`

### Task 4: Maestro 与 PR

- [ ] Step 1: `bun run verify` 绿。
- [ ] Step 2: 新 Maestro flow `roster-direct.yaml`(demo backend:主页见名单条 → 点第二个头像 → 页头「在跟 Codex 说」→ 输入发出 → 返回对话);加进 `APP_FLOWS`,分支加进 `supportsAppSnapshot`,告诉整合者。Review Focus 4 在 flow 里用推送深链冷启动验。
- [ ] Step 3: mini 上跑 App 全部 flow 绿,截主页 / 直通页两张与示意图对照。
- [ ] Step 4: PR 到 dev:主人 11-17 授权原话;`## 删掉/放松的测试` 逐条写(话题行 / 等你定位器相关断言的去留)。
