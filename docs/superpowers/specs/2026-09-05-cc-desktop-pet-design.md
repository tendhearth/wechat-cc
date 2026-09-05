# CC 桌宠 v1 集成:新的 renderer,接在旧的真实能力上(2026-09-05)

来源:`~/Documents/Codex/2026-09-05/referenced-chatgpt-conversation-this-is-an-3/outputs/CC_DESKTOP_PET_HANDOFF.md`(设计交接,以下称 handoff)与资产包 `…-2/outputs/cc-desktop-pet-assets-v1/`(36 张 PNG + `manifest.json`)。
上游:`2026-09-03-companion-presence-design.md`(三轴 presence、红线「永不撒谎」)、`2026-07-09-proactive-care-design.md`、hunt-bag / journal。

## 0. 这轮要解决的事

把桌宠的**视觉实现**从「熊 + 鱼缸」(`animation-lab.js` 的 canvas 骨骼动画)换成 handoff 定义的角色 **CC**:一只住在屏幕边缘的小生命,两种光照态(unlit 黑影 / lit 奶油色 + 两叶芽),13 个行为状态,一段 8 帧 unlit→lit 转场,8 个独立道具。渲染层改成 **manifest 驱动的精灵运行时**,业务代码只说 `pet.setState('working')`,不认识任何 PNG 文件名。

**不换的**:presence 三轴、journal / 包袱、心愿与介绍、日程判断、pending-permissions、companion memory、proactive care。这些是「真实能力」,CC 是接在它们上面的新 renderer 和新视觉语言,不是 Companion v3 重写。

母题(handoff):**You can leave. CC stays.** CC 靠「记得」和「守着」建立关系,不靠频繁说话。红线不变:**桌宠只报真实动作**,任何状态都由真实事件驱动,不用定时器假装完成。

owner 拍板(2026-09-05,原文):
1. **微光定义。** 微光代表「人的注意真正抵达 CC / 双方重新建立连接」,不是奖励、XP、任务完成标记,也不是 onboarding 一次性事件。典型触发是用户主动消息、久别后的重新互动、CC 主动跟进后用户回应、用户介入 permission。Unlit 表示安静守候,Lit 表示最近正在发生真实连接;一段安静期后自然退回 Unlit。v1 暂不锁死具体 dim timeout。
2. **thinking / done 定义。** 以真实 turn / job 生命周期为准,不以旧「打猎 / 串门」叙事映射。thinking = turn 已开始、主要处于模型推理 / 生成下一步阶段;working = 工具调用、命令、编辑或真实后台工作;done = 一次 user-visible work unit 或后台 job 真正完成。
3. **permission。** 桌宠增加真实可点击 UI,但不能产生第二套权限系统。复用 daemon 现有 pending-permissions 作为 single source of truth;微信和桌面只是两个 presentation surface,任何一端 resolve 后另一端同步消失。桌宠 UI 保持小而克制,复杂细节可展开查看。

## 1. 范围:两段

- **Phase A —— 纯桌宠运行时(不碰 daemon)。** manifest loader、form × behavior 状态机、动画解析与 fallback、精灵渲染、转场播放、道具层、透明窗口与拖动、一个调试用的状态切换页。用假事件跑通 `unlit → 转场 → lit → receive → thinking → working → done → idle`。这一段先做的原因:如果 CC 在桌面上不好看,马上知道,不用先改 daemon。
- **Phase B —— 真实事件桥。** 接 presence、新的 turn 端点、journal 计数、pending-permissions、主人联系时间;把假事件一条条换成真事件;桌宠权限卡片。

一份 spec、两份 plan、两条分支。Phase A 合入后桌宠窗已经是 CC(靠 presence 的现有字段先跑最小映射),Phase B 再让它「真的知道自己在做什么」。

**另开、不混进来:** 叙事清扫(下载页 `hero-bear.png`、界面与提示词里的「熊」、「鱼缸」、包袱 / 打猎的措辞、`animation-lab.*` 的去留)。

## 2. 领域模型(桌面侧,纯函数)

```ts
type PetForm = 'unlit' | 'lit'
type PetBehavior = 'idle' | 'blink' | 'look' | 'receive' | 'working' | 'thinking' | 'permission'
  | 'done' | 'companion' | 'sleep' | 'drag' | 'wake' | 'error'
type PetTransition = 'unlit-to-lit' | 'lit-to-unlit'
type PetProp = 'micro-light' | 'sprout' | 'laptop' | 'envelope' | 'speech-bubble' | 'thought-bubble' | 'exclamation' | 'mug'
```

状态机持有 `{ form, behavior, transition: PetTransition | null, props: Set<PetProp>, badge: number }`。规则:

- **优先级**(handoff §5.4):`permission > drag > transition > error > receive/done/wake > working/thinking > sleep > companion > look/blink > idle`。同一时刻只有一个主体动画;低优先级请求在高优先级进行中被记为「待回落目标」,不打断。
- **一次性状态**(`blink look receive done drag wake error`)播完回落到「待回落目标」或 `idle`;**持续状态**(`idle working thinking permission companion sleep`)保持到下一个事件。
- **转场**只由 form 变化触发:`setForm('lit')` 且当前 unlit → 播 `unlit-to-lit`,播完 form=lit,再回落;`setForm('unlit')` 且当前 lit → 缺 `lit-to-unlit` 资产时走 fallback(§3),不倒放。
- **道具**独立于主体:`setProps(set)` 随时生效;badge 只挂在 `envelope` 上。
- `drag` 由窗口层直接进入 / 退出,不经过事件桥。

## 3. Manifest 与 fallback

资产目录:`apps/desktop/src/assets/pet/`,内容 = 资产包的 `manifest.json`、`reference/`、`states/`、`transitions/`、`props/`、`README.md`(不带 `source/` 原始图集)。**整包替换即升级**:换目录不改代码。

Loader(`manifest-loader.js`,纯)接受两种形状:
- **v1 扁平**(资产包现状):顶层 `states` 全是 lit 帧;`canonical.unlit` / `canonical.lit` 是两张 master;`transitions.unlit-to-lit` 八帧;`props` 名 → 路径;`canvas.anchor` 为比例 `[0.5, 0.91796875]`(= 256, 470 px)。Loader 把它归一成 `forms.lit.states = states`、`forms.unlit.states = { idle: { frames: [canonical.unlit], fps: 1, loop: true } }`。
- **forms 嵌套**(handoff §6.1 的目标契约):`forms.<form>.states.<behavior>` 直接用。

校验分两级:**无法解析**(不是 JSON、没有 canvas、一个 form 都没有)→ loader 返回 `{ ok:false }`,窗口显示一张静态 master 与一行 warning,不崩;**可降级缺失**(某 behavior 缺、某 transition 缺、frames 空、文件 404)→ 记 warning,走 fallback。

Fallback 链(`animation-resolver.js`,纯,输入 form + behavior + manifest,输出 `{ frames, fps, loop, next }`):

| 缺什么 | 用什么 |
|---|---|
| `forms[form].states[behavior]` | 同 form 的 `idle` → 该 form 的 master → `lit.idle` |
| `transitions.lit-to-unlit` | 不倒放;由渲染层做 240 ms 淡出 → 切 `unlit.idle` → 淡入 |
| unlit 下任何非 idle 行为(v1 只有一张 master) | `unlit.idle`(master-unlit + 呼吸),**逻辑状态保留**(状态机仍记 `working`),只是画面回退 |
| 未知 behavior 字符串 | 当前 form 的 `idle` + warning |
| 某帧图片加载失败 | 跳过该帧;整个动画无帧时按上一行处理 |

**禁止**(handoff §4.2):为单帧写 offset / 缩放 / 裁切;按 alpha bbox 矫正;业务层认识文件名;用复制覆盖资产补状态;因资产缺失崩溃。绿边、基线跳动、猫化、wake/sleep 不连续,一律登记为 v1.1 美术项,代码不修。

## 4. 渲染

- **舞台**:`companion-window.html` 里一个 `.pet-stage`(正方形,尺寸随窗口),内含主体 `<img class="pet-sprite">` 与道具层 `<div class="pet-props">`。逐帧 = 换 `src`(帧图预加载);anchor 用 manifest 的比例值定位到舞台底部中线,和 `transform-origin` 一致。不用 canvas。
- **克制的运动**(README:keyframes 不是动画库,小动作由 renderer 做):持续状态上叠一层呼吸 `scale 1.00→1.02`、周期 2.8 s;`blink` 每 6–12 s 随机一次,`look` 每 25–60 s 随机一次,两者都只在 `idle/companion` 下发生且可关;转场按 manifest 的 8 fps 逐帧;`prefers-reduced-motion` 下关掉呼吸与随机动作,转场改为首末帧 cross-fade。
- **道具层**:道具图 384×384,manifest 没有偏移信息 → 用一张**集中的槽位表** `PROP_SLOTS`(相对 anchor 的比例偏移与缩放:`above-head`、`beside-right`、`in-front`),道具名 → 槽位在 `prop-layer.js` 一处定义。这是槽位而不是逐帧 offset,允许。`envelope` 带 badge 数字。
- **窗口**(Rust 侧复用现有 `companion` 窗与命令 `open/close/start_companion_drag/resize`):transparent、no decorations、always-on-top、skip-taskbar 保持;内尺寸改为 240 × 300(上半 CC,下半留给权限卡与提示,平时透明);整只 CC 是 drag-region,拖动时状态机进 `drag`,松手回落;位置不持久化(现状也不,列 future);缩放 ± 保留。
- **文字**:CC 不说话。唯一的文本是权限卡与「daemon 没起」的一行提示;`bear-message` 气泡、鱼缸提示全部删除。

## 5. 事件桥(Phase B):presence 管处境,turn 管在做什么

### 5.1 两个数据源

**presence**(现有 `GET /v1/companion/presence`,20 s 轮询,不改)→ 处境:

| presence / activity | CC |
|---|---|
| daemon 没起(拉不到) | form unlit、`sleep`、无道具,一行提示「daemon 没起」 |
| `presence: offline`(微信断) | form unlit、`sleep`;journal 道具与 badge 保留(计数仍可信) |
| `presence: degraded` | 进入时播一次 `error`,之后 `idle` + `exclamation` 道具,直到恢复 |
| `activity: hosting_human / visiting / hosting_peer` | `companion` |
| `activity: foraging / working`(busy token) | `working` + `laptop`(仅当 turn 端点说 idle;turn 优先) |
| `activity: chatting / idle` | 交给 turn 端点 |
| `news.unread > 0` | `envelope` 道具 + badge;unread **增加**时播一次 `receive` |

**新端点 `GET /v1/companion/pet`**(trusted;lit 或回合进行中时桌面 2 s 轮询,否则 10 s)→ 在做什么。daemon 侧纯函数 `src/core/pet-turn.ts` 从真实信号推导:

```ts
{
  owner_last_contact_at: string | null,   // 主人最近一次真实联系(§5.2)
  turn: { phase: 'idle' | 'thinking' | 'working' | 'permission', since: string | null },
  last_done_at: string | null,            // 主人会话最近一次 turn 结束(provider `result` 事件)
  pending_permissions: Array<{ hash: string, prompt: string, since: string, expires_at: string }>,
}
```

推导(只看主人会话):有待决权限 → `permission`;会话在飞且最近 `WORKING_WINDOW_MS = 5_000` 内有 `tool_call` 事件 → `working`;会话在飞 → `thinking`;否则 `idle`。这需要 daemon 记两个时间戳:主人会话最近一次 `tool_call` 与最近一次 `result`(在会话事件流经过的地方各记一次,不新增表)。

桌面映射:`phase` 变化即 `setState`;`last_done_at` **前进** → 播一次 `done`(边沿触发,播完回落;后台 job 完成走 journal 的 `receive`,不重复);`permission` 时同步显示权限卡(§6)。turn 端点的状态**优先于** presence 推出的 `working/companion`。

### 5.2 微光与两态

`owner_last_contact_at` = max(主人微信会话最近一条入站,`/v1/companion/converse` 最近一次调用,主人最近一次 resolve 权限)。daemon 侧在 converse 与 consume 处各记一个时间戳;微信入站已有(`latestInboundTs`)。

- form=unlit 且 `owner_last_contact_at` 前进 → `setForm('lit')`(播 8 帧转场,转场里 `micro-light` 道具由转场帧自带,不叠加)。
- form=lit 且前进 → 只播一次 `receive` 并短暂显示 `micro-light` 道具(轻响应,不变身)。
- form=lit 且 `now − owner_last_contact_at > LIT_DIM_MS`(常量,默认 20 分钟,v1 不锁死)且 turn idle 且无待决权限 → `setForm('unlit')`(淡出淡入)。
- offline / daemon down 不改 form 的「事实」但画面走 §5.1 的 unlit;恢复后按上面规则重算。

首次出现:窗口打开时按 `owner_last_contact_at` 直接算出 form,**不播转场**(转场只给「变化」)。

### 5.3 轮询节奏

| 条件 | pet 端点 | presence |
|---|---|---|
| lit 或 turn ≠ idle 或有待决权限 | 2 s | 20 s |
| unlit 且 turn idle | 10 s | 20 s |
| 窗口不可见 / 最小化 | 停 | 停 |

## 6. Permission:一个权限,两个呈现面

daemon:
- `PendingPermissions.register(hash, timeoutMs)` 改为 `register(hash, timeoutMs, meta: { chatId, prompt })`,内部保存 `{ registeredAt, timeoutAt, meta }`;新增 `list(): Array<{ hash, chatId, prompt, since, expires_at }>`。`consume / fail / sweep` 不变。
- 路由(**admin** 档,不是 trusted:这是权限本身):`GET /v1/permissions/pending` → `{ items }`;`POST /v1/permissions/resolve { hash, decision: 'allow' | 'deny' }` → `{ ok: consume(hash, decision) }`。微信那条「允许 <hash>」照旧走同一个 `consume`。`GET /v1/companion/pet` 里的 `pending_permissions` 就是 `list()` 过滤到主人会话。

桌面(`pet/permission/permission-card.js`):
```
      CC(permission 姿态)
   这个要你看一下
 [允许]  [拒绝]  [查看]
```
真实 `<button>`,可 Tab、可 Enter / Esc;`查看` 就地展开 prompt 全文(等宽、可滚动,不截断安全信息);多条时只显示最早一条,右上角计数。任一端 resolve → 下一拍列表里没了 → 卡片消失,CC 回到此前状态。拒绝**不是** `error`。桌面 token 若不是 admin 档 → 卡片只显示「微信里有一条等你确认」,不出按钮。

## 7. 文件清单

**Phase A(桌面,纯前端)**

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/assets/pet/**` | 资产包(manifest、reference、states、transitions、props、README) |
| `apps/desktop/src/pet/domain/types.js` | PetForm / PetBehavior / PetTransition / PetProp、优先级表 |
| `apps/desktop/src/pet/domain/state-machine.js` + test | `createPetStateMachine()`:setForm / setState / setProps / notifyAnimationEnded / snapshot;纯,不碰 DOM |
| `apps/desktop/src/pet/assets/manifest-loader.js` + test | 两种形状归一、两级校验、路径解析 |
| `apps/desktop/src/pet/assets/animation-resolver.js` + test | form + behavior + manifest → 动画 / fallback,附 warning 列表 |
| `apps/desktop/src/pet/renderer/sprite-renderer.js` + test | 帧播放、fps、loop、anchor、呼吸、reduced-motion、淡出淡入(DOM 用最小可测接口) |
| `apps/desktop/src/pet/renderer/prop-layer.js` + test | 槽位表、badge |
| `apps/desktop/src/pet/pet.js` | 组装:loader → resolver → machine → renderer,导出 `createPet(stageEl, { manifestUrl })` 给窗口用;`window.__pet` 仅在 lab 页暴露 |
| `apps/desktop/src/companion-window.html/.js/.css` | 重写:舞台 + 拖动区 + 关闭 / 缩放;去掉鱼缸、气泡、螃蟹;先用 presence 的现有字段做 §5.1 的处境映射(turn 部分等 Phase B) |
| `apps/desktop/src/pet-lab.html/.js` | 调试页:13 个状态按钮、两态切换、转场、道具勾选、reduced-motion 开关、warning 列表 |
| `apps/desktop/src-tauri/src/lib.rs` | `open_companion_window` 尺寸改 240 × 300;其它命令不动 |

不动:`animation-lab.*`(窗口不再引用它,文件留到叙事清扫)、`presence-poller.js`、`companion-presence.js`(主窗那侧的展示)。`companion-scene-state.js` 的 `SceneState`(熊的姿态词表)在 Phase A 被 `pet/bridge/presence-map.js` 取代:presence → `{ form?, behavior, props, badge }`。

**Phase B(daemon + 桌面桥)**

| 文件 | 职责 |
|---|---|
| `src/core/pet-turn.ts` + test | 纯推导:`derivePetTurn({ nowMs, inFlight, lastToolCallAt, lastResultAt, pendingForOwner, ownerLastContactAt })` |
| `src/daemon/pending-permissions.ts` + test | `register(hash, timeoutMs, meta)`、`list()` |
| `src/daemon/internal-api/routes-pet.ts`、`routes-permissions.ts`、`route-tiers.ts`、`types.ts` | `GET /v1/companion/pet`(trusted)、`GET /v1/permissions/pending`、`POST /v1/permissions/resolve`(admin) |
| 会话事件经过处(`conversation-coordinator` / session manager 的事件分发点)+ `ilink-glue.askUser` + converse 路由 | 记 `lastToolCallAt / lastResultAt`、`register` 传 meta、记 converse / consume 时间 |
| `apps/desktop/src/pet/bridge/runtime-events.js` + test | presence + pet 端点 → 领域事件(边沿检测:unread 增加、last_done_at 前进、contact 前进、phase 变化);两档轮询 |
| `apps/desktop/src/pet/permission/permission-card.js` + test | §6 卡片 |
| `apps/desktop/src/companion-window.js` | 接 bridge |

不动:`companion-presence.ts` 的推导、`calibration.ts`、journal、wish / intro / plan。

## 8. 验收

**Phase A(pet-lab 页 + 真窗口):**
- 透明窗里 CC 按 anchor (256, 470) 定位,窗口缩放时不漂。
- 13 个状态都能请求;unlit 下请求任何状态画面回到 master-unlit、逻辑状态保留、warning 列表有记录。
- `unlit → lit` 8 帧按序播完,form 变 lit;`lit → unlit` 走淡出淡入,不倒放。
- `idle → receive → thinking → working → done → idle` 用 lab 按钮跑通;`done` 只播一次。
- 拖动进入 `drag`、松手回落;拖动中不改 form 与道具。
- 道具与主体分层;`envelope` 带 badge。
- 删掉 `assets/pet/states/working/` → 请求 `working` 回退到 `lit.idle`,不崩,warning 一条。
- 换一套 `forms` 嵌套形状的 manifest 也能加载(loader 测试)。
- `prefers-reduced-motion` 下呼吸与随机动作关闭。
- 真窗口接上 presence:daemon 没起 → unlit sleep + 提示;有未读 → envelope + 数字;主人在聊(chatting)→ lit(Phase A 先用 chatting 的 3 分钟窗代替 §5.2 的 20 分钟,Phase B 换成真实 contact 时间)。

**Phase B(两台真机):**
- 微信给主人的伙伴发一句 → 2 秒内 CC 从 unlit 亮起(8 帧)→ thinking → 回复发出后 done 一次 → idle;20 分钟不理它 → 淡回 unlit。
- 触发一次需要权限的工具调用 → CC `permission` + 卡片;在微信回「允许」→ 卡片消失、CC 回 working;反过来在卡片点「拒绝」→ 微信侧那条提示随后收到 resolved,turn 按 deny 走。
- 打猎带回东西 → envelope + badge,receive 一次;主窗看过(seen 水位前进)→ badge 消失。
- 断网(offline)→ unlit sleep,道具仍在;恢复 → 按 contact 时间重算 form,不多播转场。

## 9. 明确不做 / 待办

- 不重画、补帧、生成任何 CC 图;不修绿边 / 基线 / 猫化;不倒放转场当 lit→unlit。
- 不做第二套权限逻辑;不把权限细节做成图片按钮。
- 叙事清扫(熊 / 鱼 / 包袱 / 打猎 / 下载页 / `animation-lab`)另开一轮。
- 窗口位置持久化、多显示器、边缘吸附、系统启动恢复:future。
- `LIT_DIM_MS` 的最终值、是否可配置:dogfood 后定。
- v1.1 资产:`lit → unlit` 转场、unlit 生存集(idle / blink / look / sleep)、wake/sleep 连续性 —— 由资产包整包替换,不改代码。
