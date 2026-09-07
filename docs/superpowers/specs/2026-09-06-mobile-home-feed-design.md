# 随身 CC 首屏：伙伴的一天（feed）— 设计

日期:2026-09-06
状态:待实现
父级脉络:`2026-08-26 随身 CC 远程中继(tunnel-client)`、`2026-09-03-companion-presence`、`2026-09-05-cc-desktop-pet`、`journal-store(v36/v40)`

## 0. 一句话

把 `/m` 手机页的首屏从「待办 / 小像 / 贴纸」换成**伙伴的一天**:一条只读的事件流,读时合并三个已有来源(背包 journal、伙伴自己的决定 plan-log、聊天日摘要 turn_records),外加当下的 presence。视觉/形象后贴,这轮只做契约、数据、朴素页面。

## 1. 背景与要验证的假设

手机版的定位已定:**拓麻歌子式的社交层窗口**——在这里看 CC 的生活(打猎、串门、交朋友),微信继续做分享与快速聊天的漏斗。路线:先 A(手机看自己的 CC,不依赖第二台真机)→ 乙(精灵 + 场景)是 A 契约上的一层皮。

A 要验证的唯一假设:**主人会不会主动掏出手机看它**。

真机数据(2026-09-06)决定了 A 的形态:

| 来源 | 量 |
|---|---|
| `journal`(hunt/visit/postcard) | 全史 3 条 |
| `plan-log`(伙伴的决定) | 今天 4 条,其中 2 条是「没朋友可串门,在家歇着」 |
| `turn_records`(对话回合) | 每天 1–4 回合 |

只靠 journal 的首屏大多数时候是空的,会把假设检验成假阴性。所以:

- **伙伴的「想法」算事件**(决定不出门也是内容,而且 plan-log 已经把 `why` 写好了)
- **聊天算生活**,但只给一天一行的摘要
- **断连时给带时间戳的「上次」**,不给空白(主人自己的 Mac 白天合盖)

接入层(NAT 穿透、端到端加密、设备配对、PWA 外壳)**已经建好**(`src/daemon/tunnel-client.ts`、`/m/manifest`、`/m/sw`),本轮不碰。

## 2. 范围

做:
1. 事件流契约与三个来源的读时合并
2. `GET /m/api/home`、`GET /m/api/feed`、`POST /m/api/seen`
3. plan-log 留存从「只留当天」改为「留 14 天」
4. presence 计算从路由里抽出来共用
5. `/m` 首屏改版(feed 为主体,原三块降为第二个 tab),页面侧带时间戳缓存

不做(明确):
- 视觉、精灵、场景、动画(乙;形象另行设计中)
- 推送、后台刷新、下拉手势
- 首屏写操作(除 seen 水位;现有 todo 勾选保留在第二 tab)
- 把想法/聊天写进 journal(journal 是背包,条目有 tried/using/dropped 语义)
- 提高伙伴活动密度(打猎更勤、单人活动)——A 的数据会把它逼出来,另开
- 陌生人层 / 会合点 / 视频
- docs 里 `brain.youdamaster.cc` 的历史残留清理(代码已全在 tendhearth;文档另开小任务)

## 3. 事件流契约

### 3.1 事件信封

```ts
interface FeedEvent {
  id: string        // 全局唯一、稳定:`journal:<id>` | `thought:<at>` | `chat_day:<YYYY-MM-DD>`
  ts: string        // ISO,排序键
  kind: 'hunt' | 'visit' | 'postcard' | 'thought' | 'chat_day'   // 开放,之后可加 letter/intro/…
  title: string
  note: string | null
  ref?: { url?: string | null; image_svg?: string | null; status?: string }   // 仅 journal 类携带
}
```

`kind` 是开放的:penpal 来信、a2a 事件之后并进来只加来源,不改契约。**形象无关**:契约只说发生了什么,不说长什么样——这是乙能直接贴皮的前提。

### 3.2 三个来源的映射

**journal**(`Journal.list(limit)` 已有,不新加读接口)
- `id = journal:<row.id>`,`ts = row.ts`,`kind = row.kind`,`title = row.title`,`note = row.note`,`ref = { url, image_svg, status }`

**thought**(plan-log)
- `id = thought:<entry.at>`,`ts = entry.at`,`kind = 'thought'`
- `title` 由 `decision` 决定:`hunt` → 「出门打猎去了」;`visit` → 「去串门了」;`none` → 「在家待着」;其他 action 用其英文名兜底(不猜)
- `why` 以 `(failed) ` / `(skipped) ` 开头 → title 改为「想出门,没走成」,note 为 null
- **`note = why` 仅当 `source === 'model'`**;`fallback` 的 why(如 `fallback:timeout`)不是想法,不显示。这是「永不撒谎」在这里的形态:不给它编一个理由

**chat_day**(turn_records)
- 按伙伴时区(`companion/config.json.timezone`,缺省 `Asia/Shanghai`)把最近 14 天的 `outcome = 'completed'` 回合按天分桶
- 每天一条:`id = chat_day:<date>`,`ts` = 当天最后一回合的 `ts`,`kind = 'chat_day'`
- `title`:只有主人 → 「和主人聊了 N 回」;有客人 → 「和主人聊了 N 回,还和 M 位客人聊了 K 回」;只有客人 → 「和 M 位客人聊了 K 回」。客人不列名字
- `note = null`。不逐条列回合:同一主人无隐私问题,但逐条是噪音

### 3.3 合并与分页

三个来源各自有界:journal `list(200)`、plan-log 最近 14 天、chat_day 最近 14 天。合并后 ≤ 数百条,**v1 在内存合并排序**,不做 SQL 级多源游标(YAGNI)。

- 排序:`ts` 降序,同 `ts` 按 `id` 升序(稳定)
- 游标:不透明字符串 = base64(`${ts}|${id}`);翻页取 `(ts, id)` 严格小于游标的那一段
- 分页范围是「合并后的有界窗口」,不是无限历史;文档与代码注释都要写明

### 3.4 未读

`unread = 合并窗口内 ts > seenUntil 的事件数`(三源都算)。

注意它和 `presence.news.unread` **不是一个数**:后者是 `journal.summary(seenUntil)`,只算背包,桌面桌宠脚边的包袱继续用它,本轮不改。两者共用同一个水位文件 `companion/journal-seen.json`(决定:一个主人一个水位,手机看了桌面也算看了)。

## 4. 接口

三个都挂在 settings-panel 的 `/m/api/*` 命名空间下,经隧道走同一个 `handleRequest`,设备 token 鉴权与现有 `/m/api/state` 相同。

### `GET /m/api/home`

```ts
{
  ok: true,
  synced_at: string,                    // 服务端 now,页面拿它做「上次同步」与 seen
  presence: Presence | null,            // null = 拿不到;页面显示「不知道」
  presence_error?: 'unavailable',
  unread: number,
  seen_until: string | null,
  events: FeedEvent[],                  // 首屏 30 条
  next_cursor: string | null,
  sources_degraded: Array<'journal' | 'thought' | 'chat_day'>   // 哪个来源这次没读到
}
```

单一来源失败**不 500**:跳过该来源、记入 `sources_degraded`,其余照给。全部失败也返回 `ok: true` + 空 events + 三项 degraded(页面据此显示「今天读不到它的日记」,而不是把空当成「什么都没发生」)。

### `GET /m/api/feed?cursor=&limit=`

`{ ok, events, next_cursor }`。`limit` 上限 100,缺省 30。坏游标 → 400 `invalid_cursor`。

### `POST /m/api/seen`

body `{ until: string }`。规则:
- 非法 ISO → 400
- `until` 夹到 `now`(不许把水位推到未来)
- **单调**:小于现有水位则不写、返回现有值(桌面与手机两边推,谁靠后算谁)
- 返回 `{ ok, seen_until }`

### `GET /m/api/state`

不变(第二个 tab 继续用)。

## 5. daemon 侧改动

### 5.1 plan-log 留存(`src/daemon/companion/plan-memory.ts`)

文件形状从 `{ day, entries }` 改为 `{ days: { [YYYY-MM-DD]: PlanLogEntry[] } }`:
- `readPlanLog(stateDir, today)` **签名与语义不变**(返回 `days[today] ?? []`),tick-bodies 不用改
- `appendPlanLog` 写入后裁剪到最近 14 天
- 新增 `readPlanLogDays(stateDir, days): PlanLogEntry[]`(按 `at` 升序拍平)
- 旧形状兼容读:遇到 `{ day, entries }` 视为 `{ days: { [day]: entries } }`,下次写自动迁移
- 写失败不影响这一拍(沿用现有 try/catch)

### 5.2 presence 抽出共用(`src/daemon/internal-api/routes-presence.ts`)

把 `GET /v1/companion/presence` 处理器主体抽成 `computePresence(deps): Promise<Presence>`(输入收集逻辑原样搬,路由改为调它)。`registerInternalApi` 的返回对象增加 `getPresence(): Promise<Presence>`。main.ts 里 internal-api 本就先于 settings panel 建立,pipeline-deps 把 `presence: () => internalApi.getPresence()` 注入 settings panel(opts 里若没有 internalApi 引用则加字段)。

不在 settings-panel 里第二次拼 presence 输入——两处口径分叉正是这类 UI 撒谎的来源。

### 5.3 feed 组装(新文件 `src/daemon/mobile-feed.ts`)

纯函数 + 薄适配:
- `buildFeed(sources, opts): { events, next_cursor, degraded }` —— 输入是三个已读好的数组,负责映射、合并、排序、分页;**无 IO**,单测友好
- `thoughtTitle(entry)`、`chatDayTitle(bucket)`、`encodeCursor/decodeCursor` 导出供测
- 读 IO 的部分留在 settings-panel 的 deps 注入里(见 5.4),`mobile-feed.ts` 不 import db/fs

### 5.4 SettingsPanelDeps 新增

```ts
feed?: {
  journal: { list(limit?: number): CatchRow[] }
  planLogDays: (days: number) => PlanLogEntry[]
  turnsSince: (sinceIso: string) => Array<{ ts: string; chat_id: string; outcome: string }>
  timezone: () => string
}
presence?: () => Promise<Presence>
seen?: { read: () => string | null; write: (iso: string) => void }
```

缺省行为:`feed` 缺 → `/m/api/home` 返回三项 degraded;`presence` 缺 → `presence: null`;`seen` 缺 → `POST /m/api/seen` 503。pipeline-deps 注入:journal 用 main.ts 里已有的 `huntStore`,plan-log 用 5.1 的读函数,turns 直接查 `turn_records`,seen 用 `journal-seen.ts` 的读写。

## 6. 页面(`/m`,`src/daemon/settings-panel-html.ts` 的 `phoneHtml`)

无框架,单文件,和现在一致。

**结构**:两个 tab。默认「今天」= feed;「口袋」= 现有 待办/小像/贴纸,代码原样搬。设置入口不动。

**首屏**:
- 顶部一行 presence:`presence` / `activity.label`;`presence` 为 null → 显示「现在:不知道」
- 事件列表:每条 `title` + `note`(有则显示)+ 相对时间;journal 类带 `ref.url` 的可点;postcard 内联 `image_svg`(文本,隧道能过)
- 按天分组小标题(伙伴时区)
- 底部「再往前」按钮 → `/m/api/feed?cursor=`
- 顶部一个刷新按钮;`visibilitychange` 回到前台时重拉

**缓存与断连**(页面侧,`localStorage` 键 `cc.home.v1`):
- 打开:若有缓存,**先渲染缓存的 events**,横幅「上次同步 X 前」,presence 一律显示「不知道」——缓存里的 presence 永远不渲染
- 然后拉 `/m/api/home`:成功 → 替换、写缓存、横幅消失;失败 → 保留缓存,横幅改为「连不上家里的 CC · 显示的是 X 前的」
- 无缓存且失败 → 「连不上家里的 CC」空态
- 依据:事件是已发生的事实,不会过期;presence 是关于「现在」的断言,缓存即撒谎

**推水位**:`/m/api/home` 成功且页面可见时,`POST /m/api/seen { until: synced_at }`。用服务端时间而不是本地时间或最新事件 ts,避免拉取与推水位之间新到的事件被吞。

**空态**(区分三种,不用「暂无数据」):
- 窗口内一条都没有 → 「还什么都没发生——它刚醒」
- 有历史但今天没有 → 今天分组下「它今天还没出门」
- 三源全 degraded → 「今天读不到它的日记」

## 7. 诚实规则(汇总)

1. presence 拿不到 → 「不知道」,不用默认值,不用缓存
2. 事件缓存必须带同步时间横幅
3. `fallback` 的决定不显示理由;失败/跳过的出门记为「没走成」
4. 单源失败要在响应里可见(`sources_degraded`),页面据此区分「没发生」与「读不到」
5. 水位只前进不后退,不超过 now

## 8. 测试

- `mobile-feed.test.ts`:三源映射(含 fallback/failed/skipped 分支)、合并排序稳定性、同 ts 多条的游标翻页、`unread` 计数、时区分桶(跨 UTC 日界)、chat_day 三种 title
- `plan-memory.test.ts`:旧形状兼容读、14 天裁剪、`readPlanLog(today)` 语义不变
- `routes-presence.test.ts`:抽出后路由行为不变(若已有测试则只需仍绿)
- `settings-panel.test.ts`:`/m/api/home` 单源失败仍 200 + degraded、`/m/api/seen` 单调与夹取、坏游标 400、`feed` 缺省 → 三项 degraded
- 隧道链路:`tunnel-client.test.ts` 现有 fake WS 模式加一条 `/m/api/home` 往返
- 真机走查:Mac daemon + 手机浏览器加主屏;合盖 Mac 后打开手机页,确认横幅与「不知道」

## 9. 文件清单

新建:
- `src/daemon/mobile-feed.ts` + `.test.ts`

修改:
- `src/daemon/companion/plan-memory.ts`(留存 14 天)+ 测试
- `src/daemon/internal-api/routes-presence.ts`(抽 `computePresence`)、internal-api 返回对象加 `getPresence`
- `src/daemon/settings-panel.ts`(三个路由、deps 新字段)
- `src/daemon/settings-panel-html.ts`(`phoneHtml` 改版)
- `src/daemon/wiring/pipeline-deps.ts`(注入 feed / presence / seen)
- `docs/architecture.md` 随身 CC 段落补一句 feed

## 10. 后续(本轮不做,记下)

- 乙:精灵 + 场景贴在同一契约上
- 密度:plan-log 里「没朋友,在家歇着」会天天出现;伙伴需要更多单人可做的事
- 更多来源并入 feed:penpal 来信、intro 阶段、被串门、提醒触发
- 推送(iOS 需加主屏 + 独立 push 通道;先看 A 的数据再决定)
- 开发者账号(独立决定,同时解锁 macOS 签名/公证;与本轮无依赖)
