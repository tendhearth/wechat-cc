# 桌宠状态:伙伴在不在、在干什么、带了什么回来 — 设计

日期:2026-09-03
状态:已评审(owner 拍板「永不撒谎」红线 + 三轴模型 + daemon 算状态;本文是落笔)
起因:owner:「桌宠是不是最好有不同的状态,比如打猎去了、打猎完、和别人的 wechat-cc 互动去了」

## 0. 现状与红线

**现状。** 桌面陪伴窗口(`apps/desktop/src/companion-window.html`)和主界面首页都挂
同一个鱼缸场景 `animation-lab.js`(1183 行手调 canvas):熊挥手、说固定的话,鱼和
螃蟹按本地定时器动。**它跟 daemon 一根线都没接** —— daemon 挂了、微信断了、伙伴
正在别人家串门,熊都在原地挥手。

daemon 侧的「真实活动」信号已经存在但没人消费:

| 信号 | 在哪 | 现状 |
|---|---|---|
| 长任务登记 | `src/core/busy-registry.ts` | label 只存不读(注释:「将来做诊断接口时再暴露」) |
| 串门会话 | `src/daemon/bootstrap/wire-visit.ts` | 远程会话从信件重建,内存里**没有**「进行中」集合 |
| 主人 / 访客会话 | `InternalApiDeps.listSessions` | 有 `chatId` + `lastUsedAt`,只被 `/v1/health` 数个数 |
| 微信链路 | `outbound-health` | `state ∈ unknown / ok / degraded` |
| 子系统 | `subsystems()` | 降级启动状态 |
| 带回来的 | `journal` 表(v40) | 有 `status` 列,但 `new` 在界面上是「没试过」不是「没看过」 |

**红线(owner 拍板):桌宠说的每一件事都能在日志里对上。** 状态只能从 daemon
正在做的事推导,不允许为了热闹演一段「去河边看看」。装饰动作可以有,但装饰动作
**永远不配故事文案**;「去串门了」四个字只在 journal 真的会多一条的时候出现。

## 1. 模型:三个互不干扰的轴

一条扁平的状态列表(打猎中 / 打猎完 / 串门中……)会打架:正在串门时主人发来消息
算什么。拆成三轴,叠加出画面:

- **在不在(presence)**:`ok | degraded | offline`;daemon 本身没起由桌面判为 `down`。
- **在干什么(activity)**:`idle | chatting | hosting_human | visiting | hosting_peer | foraging | working`。
- **带了什么回来(news)**:主人还没看过的 journal 条数 + 最新一条的 kind / 标题。

三轴的**每一个值都有一个真实来源**(§2),没有来源的值不存在。

## 2. 事实源:daemon 一个纯函数 + 一个接口

### 2.1 `derivePresence(inputs)` — `src/core/companion-presence.ts`(纯函数)

```ts
export interface PresenceInputs {
  nowMs: number
  ownerChatId: string | null
  sessions: ReadonlyArray<{ chatId: string; lastUsedAt: number }>
  busyLabels: ReadonlyArray<string>
  visit: { id: string; peerLabel: string; hosting: boolean; sinceMs: number } | null
  outbound: 'unknown' | 'ok' | 'degraded' | null
  subsystemsDegraded: number
  journal: { unread: number; latest: { kind: string; title: string; ts: string } | null }
}

export interface Presence {
  presence: 'ok' | 'degraded' | 'offline'
  activity: { kind: ActivityKind; label: string; since: string | null }
  news: { unread: number; latest_kind: string | null; latest_title: string | null }
}
```

**presence 推导:**
- `outbound === 'degraded'` → `offline`(唯一诚实的「微信断了」信号,spec 2026-08-22)
- 否则 `subsystemsDegraded > 0` → `degraded`
- 否则 `ok`

**activity 推导(命中多个按此优先级取一个):**

| 优先 | kind | 来源 | 为什么这个优先级 |
|---|---|---|---|
| 1 | `chatting` | owner chatId 的会话 `lastUsedAt` 在 `ACTIVE_WINDOW_MS`(3 分钟)内 | 「正在跟你说话」永远比「出门了」更真:伙伴串门途中回你消息,画面就该回到玻璃前 |
| 2 | `hosting_human` | 非 owner chatId 的会话在窗口内 | 人类朋友在跟伙伴聊 |
| 3 | `visiting` | `visit && !visit.hosting` | 我去别人家 |
| 4 | `hosting_peer` | `visit && visit.hosting` | 别的伙伴来我家 |
| 5 | `foraging` | busyLabels 含 `hunt` 或 `social-forage` | 出门找东西(打猎 / 派心愿) |
| 6 | `working` | busyLabels 含任何**其它**非 `api:` 前缀的 label | 在忙一件事(委派、客户回顾、整理记忆、帮别人答题、未知 label) |
| 7 | `idle` | 以上都不 | 闲着 |

两类 label **必须过滤**,它们不是伙伴的活动:`api:*` 是 internal-api 分发器给每个非 GET
请求持的 token(否则桌面自己的 POST 会让熊「在忙」);`companion-*` 是三个调度器
(push / introspect / ingest)每一拍都持的例行 token(否则熊每分钟都「在忙」)。打猎
在 push 那一拍里,所以要有自己的 `hunt` 名字(§2.2)。其余未知 label 归 `working`
而不是忽略:它确实在干活,只是我们不知道叫什么。

`label` 是给人看的一句话:`chatting` →「在跟你聊」;`visiting` →「去 X 家串门了」;
`hosting_peer` →「X 来串门了」;`hosting_human` →「家里有客人」;`foraging` →「觅食中」;
`working` →「在忙一件事」;`idle` → `''`。`since` 是该活动开始的 ISO 时间
(会话用 `lastUsedAt`,串门用 `sinceMs`,busy 没有开始时间给 `null`)。

**news 推导:** 原样透传输入(计数在存储层做,§2.3)。

### 2.2 输入从哪来(daemon 接线,`bootstrap/wire-*.ts`,不进 index.ts)

- **busy-registry** 加 `labels(): string[]`(返回快照,不暴露 Map)。
- **wire-visit** 加一个进行中登记:`activeVisit(): { id; peerLabel; hosting; sinceMs } | null`。
  `startVisit` 成功发出第一句时登记(`hosting=false`);`onInbound` 收到**新 id** 的第一封时
  登记(`hosting=true`);`finish` 和所有中止路径清除。**只登记最近一趟**(两趟重叠是边缘情况,后开的覆盖先开的;真机若观察到再细化)。加 `VISIT_STALE_MS = 6h`:超过就视为夭折并清除 —— 对端永远不回信时,
  熊不能永远不在家,那也是撒谎。
- **hunt tick** 现在**不持** busy token(查证:`tick-bodies.ts` 里没有)。加
  `holdBusy('hunt')` 包住整个打猎轮次,这是它本来就该做的(spec 2026-08-11 的漏网)。
- **sessions / outbound / subsystems**:`InternalApiDeps` 里现成的 thunk。
- **ownerChatId**:`loadCompanionConfig(stateDir).default_chat_id`。
- **journal**:§2.3。

### 2.3 「没看过」水位 — 不借用 journal.status

`journal.status` 的 `new` 在桌面日志页是「没试」筛选项(`modules/journal.js`),语义是
「这条战利品主人还没试过」,和「主人还没看过」是两回事,借用会把两个概念缠死。

改为独立水位:`<stateDir>/companion/journal-seen.json` = `{ "seenUntil": "<ISO>" }`
(和 `companion/neighbors.json` 一个目录)。

- `Journal.summary(seenUntil)` → `{ unread: count(ts > seenUntil), latest: 最新一条 {kind,title,ts} | null }`
  (一条 SQL,`hunt_catch_ts` 索引已在)。
- `POST /v1/journal/seen` → `seenUntil = now`,返回 `{ ok: true, seen_until }`。
  桌面日志页**每次被打开**时调一次;点包袱进日志页自然也就调了。

### 2.4 接口

`GET /v1/companion/presence` → `Presence`(§2.1)。

- tier **trusted**(与 `/v1/journal` 同级;桌面用 FILE token 即 trusted。不能设
  admin —— 觅食台 2026-07-22 就是这么静默 403 了一个月)。
- zod schema 进 `internal-api/schema.ts`,`ROUTE_MIN_TIER` 登记。
- 不新建 wire 文件:route 从 deps 收集输入、调 `derivePresence`、返回。
- 微信侧以后主人问「你在干嘛」也调 `derivePresence`,两个界面一个事实(本轮不做,
  留接口形状)。

**另一条路否决:** 桌面自己拼 `/v1/health` + `/v1/sessions` + `/v1/journal`。拼装逻辑
会散在两边,将来微信侧再拼一遍必然对不上。

## 3. 桌面:状态到画面一层薄映射

### 3.1 轮询 — `apps/desktop/src/presence-poller.js`

照 `doctor-poller.js` 的契约(单例、去重、subscribe、无 DOM 依赖):
`createPresencePoller({ invokeApi, intervalMs = 20_000 })`。拉不到(daemon 没起 / 网络错)
→ 发布 `{ presence: 'down' }`,不保留上一次的好状态 —— 灯该灭就灭。

主界面(`main.js`)和浮窗各起一个,共用 `companion-presence.js` 里的
`startCompanionPresence()`;浮窗现在的脚本是非 module,不改它,另加一个
`type="module"` 的小脚本 `companion-window-presence.js` 做接线。

### 3.2 `sceneStateFrom(presence)` — `apps/desktop/src/companion-scene-state.js`(纯函数)

```ts
interface SceneState {
  bearPresent: boolean
  bearPose: 'idle' | 'wave' | 'fishing' | 'busy'
  tint: 'normal' | 'dim' | 'dark'
  sign: string | null      // 沙地上的牌子;null = 没牌子
  prop: 'bag' | 'postcard' | 'letter' | null
  badge: number            // 道具上的数字;0 = 不画
  bubble: string | null    // 熊头顶一句话;只用 activity.label
}
```

| 输入 | bearPresent | pose | tint | sign | 备注 |
|---|---|---|---|---|---|
| `down` / `offline` | false | – | dark | 「离线」 | 不是故事,是事实;不写「出门了」 |
| `degraded` | true | 按 activity | dim | 按 activity | |
| `chatting` | true | wave | | null | bubble「在跟你聊」;**不显示内容** |
| `hosting_human` | true | wave | | 「家里有客人」 | |
| `visiting` | **false** | – | | activity.label | 缺席就是内容 |
| `hosting_peer` | true | idle | | activity.label | 第二个剪影留到 4b |
| `foraging` | true | **fishing** | | 「觅食中」 | 复用现成钓鱼手臂 |
| `working` | true | busy | | null | bubble「在忙一件事」 |
| `idle` | true | idle | | null | 允许装饰动作 |

`prop` 按 `news.latest_kind`:`hunt` → bag;`visit` / `postcard` → postcard;`letter` → letter;
其它 → bag;`unread === 0` → null。`badge = unread`。

### 3.3 animation-lab 的改动面

只加一个入口:`window.__companionScene.setState(sceneState)`,内部把 SceneState 存成
一份,渲染循环读它:

- `bearPresent=false` 跳过熊的绘制(熊的位置空出来,牌子画在那);
- `bearPose='fishing'` 走现有钓鱼手臂 mesh;`'busy'` 复用 idle 姿势 + bubble;
- `tint` 在最后一层叠一个半透明遮罩;
- 牌子、三个道具、数字角标是**唯一新画的素材**(小 PNG 或直接 canvas 画);
- `bubble` 走现有 `#bear-message` 元素,但有 bubble 时**停掉**固定问候语的轮播
  (两套文案打架会很怪)。

现有的 hover 挥手、螃蟹逃跑、鱼群跟随一律不动。

### 3.4 闭环:点道具进日志

「日志页」= 觅食台里的「带回来的」区块,pane 名是 `a2a-agents`。道具是 canvas 上的
一块命中区。点中 → 浮窗 `invoke('show_main_window', { page: 'a2a-agents' })`(新 tauri
命令:显示并聚焦主窗口,`emit('wechat-cc:navigate', { page })`);主界面监听该事件
(只认白名单里的 pane)切到觅食台;`switchPane('a2a-agents')` 时调 `POST /v1/journal/seen`
(§2.3)并立刻刷一次轮询,道具消失。主界面首页鱼缸里点道具直接 `switchPane`,不经 tauri。

## 4. 明确不做

- 饥饿、心情、亲密度等数值 —— 给假需求找存在感,和「真实生活」背道而驰
- 浮窗里显示任何聊天内容 —— 桌面是别人能路过看见的地方
- 夜晚 / 睡觉状态 —— daemon 没有这个概念(只有心跳的 sleep/wake 恢复),不为画面造概念
- websocket / SSE —— 这些状态分钟级变化,20 秒轮询够用
- 第二个伙伴剪影(hosting_peer)、道具按 kind 分别绘制的精细版 —— 4b,等真机看过再说
- 重排 `animation-lab.js` —— 只加 `setState` 入口,不趁机重构

## 5. 测试

| 单元 | 测什么 |
|---|---|
| `derivePresence` | 7 种 activity 各一条;优先级两两覆盖(chatting 压 visiting、visiting 压 foraging…);`api:*` 过滤;未知 label → working;3 种 presence;3 分钟窗口边界 |
| busy-registry `labels()` | 快照独立;release 后消失 |
| wire-visit `activeVisit()` | start 登记 / inbound 新 id 登记 hosting / finish 清除 / 中止清除 / 6h 过期 |
| `Journal.summary` | 水位前后计数;空表;latest 取最新 |
| route | 200 形状对 zod;未接线 503;tier 是 trusted(admin 不 403 —— 用 route-tiers 测试现有写法) |
| `sceneStateFrom` | §3.2 表逐行;`unread=0` 无道具;down 时 sign 是「离线」不是故事 |
| presence-poller | 去重;失败发布 down;subscribe 契约(照 doctor-poller.test.ts) |

desktop-e2e 一直是红的(Playwright drawer 超时),不依赖它;画面用 `animation-lab.html`
人工过一遍七种状态即可。

## 6. 切片(每步独立可提交、测试绿)

1. **daemon 事实源**:busy-registry `labels()`;hunt tick 持 `hunt` token;`derivePresence` + 测试;
   `Journal.summary` + `journal-seen.json` + `POST /v1/journal/seen`;`GET /v1/companion/presence`
   + schema + tier。此时 `curl` 就能看见伙伴在干什么。
2. **串门上报**:wire-visit `activeVisit()` 登记 / 清除 / 过期,接进 route。
3. **桌面画面**:`presence-poller` + `sceneStateFrom` + animation-lab `setState` + 牌子 / 道具 / 遮罩;
   主界面与浮窗各接一个轮询器;浮窗脚本改 module。
4. **闭环**:`show_main_window` tauri 命令 + navigate 事件 + 日志页打开即 `seen` + 道具点击。

## 7. 冷启动要诚实

一台刚装好、没有伙伴的机器,前几天桌宠大部分时间就是闲着。这是真话,接受它。
邻居串门走本地驱动不需要真对端,打猎每天都有,所以两天内主人就能看到熊第一次
不在家、第一次带东西回来。这两个「第一次」是这个设计要交付的体验,不是常驻的热闹。
