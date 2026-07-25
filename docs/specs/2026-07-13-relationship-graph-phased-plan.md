# WeChat CC 关系图谱三阶段可实现方案

Date: 2026-07-13
Status: product and implementation proposal

## 1. 目标与原则

关系图谱的第一个可用产品不是“展示一张很大的网”，而是帮用户可靠地回答：

- 这个人是谁？
- 我和 ta 是什么关系？
- 我们最近聊了什么、发生过什么？
- 我答应过 ta 什么，还有什么需要跟进？
- 这些结论来自哪段聊天，是事实还是推断？

三个阶段共同遵循以下原则：

1. **证据先于洞察**：每个结构化结论尽可能关联原始消息。
2. **事实与推断分开**：明确信息、AI 推断、用户填写分层展示。
3. **用户可校准**：可确认、修改、否定、删除，且用户结论不被后续 AI 覆盖。
4. **本地优先**：原始聊天和派生知识留在本地，只处理用户明确选择的范围。
5. **渐进建模**：先完成单人档案，再累积全局视图，最后才建立多节点图谱。

## 2. 现有能力与总体架构

现有能力可直接作为关系产品的数据底座：

```text
wxvault（解密本地微信历史）
   │
   ├─ wxsearch（消息检索与原文定位）
   ├─ wxfacts（人物属性、事件、承诺等事实）
   └─ wxgraph（联系人、互动指标和关系计算）
             │
       wxperson / relationship read model
             │
      WeChat CC internal API
             │
        Desktop Relationship UI
```

三个阶段不新建另一套原始聊天存储，而是在现有插件知识层之上增加：

- 稳定的产品读模型；
- 用户校准数据层；
- WeChat CC 内部 API；
- 桌面端关系界面。

---

## 3. 第一阶段：可信的单人关系档案

### 3.1 阶段目标

让用户选择一个联系人和时间范围，生成一份可阅读、可追溯、可修正的人物关系档案。

这一阶段验证最核心的产品假设：

> 从聊天中生成的人物档案、关键事件和待跟进，是否能让用户感到“它真的帮我理解并记住了这段关系”。

### 3.2 用户流程

```text
进入“关系”
  → 选择联系人
  → 选择时间范围（3 个月 / 1 年 / 全部）
  → 确认本地分析
  → 显示生成进度
  → 查看人物关系档案
  → 查看证据或校准结论
```

### 3.3 产品范围

#### A. 生成与授权页

- 搜索和选择一个一对一联系人；
- 选择分析时间范围；
- 告知数据来源、本地处理和可删除性；
- 显示消息数、时间范围、最后更新时间；
- 支持重新生成和停止持续更新。

#### B. 人物档案

- 微信昵称、备注和头像（如数据源可用）；
- 用户对 ta 的称呼；
- 职业、公司、城市、技能、兴趣等已有证据的属性；
- 一句话人物概要；
- 用户手动备注。

#### C. 我和 ta 的关系

- 1–3 个多重关系标签；
- 认识线索（只在聊天有证据时展示）；
- 共同话题；
- 共同项目；
- 最近互动时间和联系频率的客观描述；
- 一段带证据的关系概要。

#### D. 关键事件时间轴

- 默认展示 5–20 个高信息密度事件；
- 事件包含时间、标题、摘要、参与人、关联项目和证据；
- 首次合作、项目决策、重要帮助、重要承诺等可标记为里程碑；
- 不尝试自动判断“第一次见面”或“第一次通话”，除非有明确文本证据。

#### E. 待跟进

分为三类：

- 我明确答应的事；
- 对方明确提出的事；
- AI 建议跟进的事。

每条支持：完成、忽略、修改、查看证据。AI 建议不能与明确承诺混在一起。

#### F. 证据与校准

每条派生结论展示：

- `assertion_type`: `explicit_fact | ai_inference | user_authored`；
- `confidence`: `low | medium | high`；
- 来源消息数量与时间范围；
- 可展开的证据摘要；
- 确认、修改、否定、删除操作。

### 3.4 数据对象

第一阶段只需要五个核心读模型：

```ts
type ReviewStatus = 'unreviewed' | 'confirmed' | 'corrected' | 'rejected'
type AssertionType = 'explicit_fact' | 'ai_inference' | 'user_authored'

interface EvidenceRef {
  messageKey: string
  timestamp: string
  excerpt?: string
}

interface ClaimView {
  id: string
  subjectPersonId: string
  predicate: string
  value: string
  assertionType: AssertionType
  confidence: 'low' | 'medium' | 'high'
  evidence: EvidenceRef[]
  reviewStatus: ReviewStatus
  correctedValue?: string
  firstSeenAt: string
  lastSeenAt: string
}

interface EventView {
  id: string
  occurredAt?: string
  title: string
  summary: string
  projectIds: string[]
  evidence: EvidenceRef[]
  reviewStatus: ReviewStatus
}

interface ObligationView {
  id: string
  owner: 'me' | 'contact' | 'suggested'
  text: string
  dueAt?: string
  status: 'active' | 'completed' | 'dismissed'
  evidence: EvidenceRef[]
  reviewStatus: ReviewStatus
}

interface PersonBriefView {
  person: PersonSummary
  claims: ClaimView[]
  relationship: RelationshipSummary
  events: EventView[]
  obligations: ObligationView[]
  generatedAt: string
  sourceRange: { from?: string; to?: string; messageCount: number }
}
```

用户校准建议存在 WeChat CC 自己的 SQLite 中，不直接改写插件的派生库。读取时使用 overlay 合并：

```text
插件派生结果 + 用户校准 overlay = 最终产品视图
```

这样重建 wxgraph/wxfacts 时不会丢失用户修改。

### 3.5 内部 API

建议增加一组只供桌面端使用的本地 API：

```text
GET  /v1/relationships/contacts?q=&limit=
POST /v1/relationships/analyze
GET  /v1/relationships/jobs/:jobId
GET  /v1/relationships/people/:personId
GET  /v1/relationships/evidence/:messageKey
PUT  /v1/relationships/assertions/:id/review
PUT  /v1/relationships/obligations/:id
DELETE /v1/relationships/people/:personId/derived-data
```

`analyze` 发起后可返回任务 ID，桌面端轮询进度，避免长时间分析卡住界面。

### 3.6 技术任务

1. 统一 wxperson、wxfacts、wxgraph、wxsearch 的人物 ID 和来源消息键。
2. 实现 `PersonBriefView` 组装层，不让桌面端直接调多个插件。
3. 增加用户校准表和 overlay 逻辑。
4. 增加分析任务状态和失败恢复。
5. 增加内部 API 与权限门禁。
6. 桌面端新增“关系”入口、生成页、人物详情页、证据抽屉。
7. 为删除派生数据、停止分析和重新生成增加测试。

### 3.7 验收标准

- 可从联系人列表选择一人并完成分析；
- 档案至少显示人物概要、关系概要、关键事件和待跟进四个区块；
- 有证据的结论可打开原始消息上下文；
- 用户否定或修改结论后，重新分析不会覆盖用户决定；
- 删除某人派生档案后，该人不再持续分析，除非用户重新授权；
- 界面不把 AI 推断表述为已确认事实。

### 3.8 明确不做

- 群聊人物建模；
- 全局关系图；
- 关系分数；
- 自动判断对方心理、情绪或亲密度；
- 人物之间的共同联系人；
- 通话、见面等无法完整验证的统计。

---

## 4. 第二阶段：全局人物中心与关系变化

### 4.1 进入条件

第一阶段至少满足：

- 用户愿意对多个联系人生成档案；
- 关键字段具有可接受的准确度；
- 证据查看和校准被真实使用；
- 人物 ID、消息键和校准 overlay 稳定。

### 4.2 阶段目标

把多个单人档案组织成用户日常可用的“关系工作台”，回答：

- 我最近与哪些人互动？
- 我还欠谁什么事？
- 哪些关系出现了有证据的变化？
- 我与谁在做哪些共同项目？

### 4.3 产品范围

#### A. 关系首页 / 人物中心

默认不是力导向图，而是可扫读的人物列表。

每张人物卡片显示：

- 头像、姓名、一句话关系概要；
- 关系标签；
- 最近联系时间；
- 近 30/90 天互动趋势；
- 未完成待跟进数；
- 共同项目；
- 结论待确认数。

支持排序和筛选：

- 最近互动；
- 稳定交流；
- 待跟进；
- 长期未联系；
- 共同项目；
- 关系标签。

#### B. 待跟进中心

- 跨人物汇总所有 active obligations；
- 按到期时间、来源类型、联系人筛选；
- 支持完成、延后、忽略、查看证据；
- 可跳转到对应人物档案。

#### C. 最近变化

只展示可解释的变化信号：

- 互动频率明显上升或下降；
- 新的共同项目或话题出现；
- 连续数月后恢复联系；
- 新的重要承诺或里程碑；
- 关系标签建议发生变化。

其中“频率变化”由确定性指标生成；“关系阶段变化”必须标记为 AI 推断，并给出触发事件。

#### D. 共同项目

第二阶段的 Project 是轻量读模型，不做完整项目管理：

- 项目名称和简介；
- 参与人物；
- 关键事件；
- 开放的待跟进；
- 相关聊天证据。

项目同名消歧先由用户确认，不在后台自动合并低置信对象。

#### E. 轻量关系统计

允许显示：

- 消息量；
- 活跃天数；
- 最近互动时间；
- 连续互动月数；
- 按月联系频率趋势；
- 已识别的共同项目数和事件数。

不显示伪精确的“亲密度 87 分”。如需排序，可内部使用综合分，对外显示“频繁联系 / 稳定联系 / 偶尔联系 / 久未联系”。

### 4.4 新增数据能力

```ts
interface RelationshipMetrics {
  personId: string
  messageCount: number
  activeDays: number
  lastInteractionAt?: string
  activeMonths: number
  monthlyBuckets: Array<{ month: string; count: number; activeDays: number }>
  trend: 'rising' | 'stable' | 'falling' | 'resumed' | 'insufficient_data'
  computedAt: string
}

interface ProjectView {
  id: string
  canonicalName: string
  aliases: string[]
  participantIds: string[]
  eventIds: string[]
  obligationIds: string[]
  reviewStatus: ReviewStatus
}

interface RelationshipChange {
  id: string
  personId: string
  kind: 'frequency' | 'resumed' | 'new_project' | 'milestone' | 'label_suggestion'
  summary: string
  assertionType: AssertionType
  evidence: EvidenceRef[]
  detectedAt: string
}
```

### 4.5 新增 API

```text
GET /v1/relationships/people?sort=&filter=&cursor=
GET /v1/relationships/follow-ups?status=&personId=
GET /v1/relationships/changes?from=&to=
GET /v1/relationships/projects
GET /v1/relationships/projects/:projectId
PUT /v1/relationships/projects/:projectId/review
```

所有列表使用分页或 cursor，不向桌面端一次性返回所有人的原始证据。

### 4.6 技术任务

1. 建立全局 `PeopleIndexView`，聚合人物摘要、指标、待跟进和审核数。
2. 增加按月互动桶和趋势计算，保持算法可重放。
3. 增加 Project 实体消歧和用户合并/拆分 overlay。
4. 增加 RelationshipChange 生成和去重逻辑。
5. 桌面端实现人物中心、待跟进、最近变化和项目详情。
6. 为增量更新、趋势窗口、项目合并和分页增加测试。

### 4.7 验收标准

- 人物中心可稳定展示至少 100 个人物摘要；
- 按最近互动、待跟进、长期未联系筛选结果正确；
- 用户可在一处完成跨人物待跟进；
- 一条关系变化必须可解释为指标变化或关键事件；
- 项目同名不会自动强制合并，用户合并/拆分后可持续保留；
- 增量更新不重置用户在第一阶段的校准。

### 4.8 明确不做

- 全量 Life Graph；
- 文件、地点、平台、兴趣等长尾节点；
- 全局“成长贡献榜”或情绪支持排名；
- 基于群聊的三方关系推断；
- 外部日历、GitHub 和文件系统的自动关联。

---

## 5. 第三阶段：可探索的关系网络

### 5.1 进入条件

- 已稳定积累多人档案和项目实体；
- 用户对人物、关系标签和项目的校准已形成可用数据；
- 人物与项目的身份消歧足够稳定；
- 第二阶段证明用户需要跨人物发现关联，而不只是查看列表。

### 5.2 阶段目标

让用户从自己、某个人或项目出发，探索“人—项目—事件”之间已经有证据的联系。

图谱是对前两个阶段数据的空间化阅读方式，不是一套独立的人物模型。

### 5.3 节点与边的范围

第三阶段只支持三种节点：

```text
Person
Project
Event
```

以及少量明确关系：

```text
ME --knows/relates_to--> Person
Person --participates_in--> Project
Person --involved_in--> Event
Project --contains/produces--> Event
Person --co_occurs_with--> Person
```

`co_occurs_with` 必须区分：

- 用户已确认共同认识；
- 同一项目或事件的共现；
- AI 建议关联。

未确认的共现不能直接标成“两人彼此认识”。

### 5.4 产品范围

#### A. 图谱浏览器

- 以“我”为默认中心；
- 默认只加载 10–20 个一度节点；
- 点击节点后按需展开一层；
- 可缩放、拖拽、搜索、回到中心；
- 可在人物、项目、事件之间筛选；
- 不一次渲染全部数据，视图内节点建议硬上限 50–80 个。

#### B. 节点侧边栏

点击 Person：

- 人物概要；
- 关系标签；
- 最近互动；
- 共同项目；
- 跳转完整人物档案。

点击 Project：

- 项目概要；
- 参与人物；
- 关键事件；
- 跳转项目详情。

点击 Event：

- 时间与摘要；
- 参与人物和项目；
- 聊天证据。

#### C. 关系边详情

点击“我—人物”关系边时展示：

- 关系概要；
- 客观互动指标；
- 关系时间轴；
- 共同项目；
- 关系变化；
- 为每个结论提供证据。

不为所有图边生成长文 AI 总结；仅在用户打开详情时读取已有摘要，需要时才增量刷新。

#### D. 探索式查询

提供一组可解释的预设查询：

- 和我最近互动的人；
- 参与某项目的人；
- 与某人有共同项目的人；
- 某个时间段内的关键事件；
- 有开放待跟进的人。

它们应转换成确定性图查询，不依赖 LLM 每次自由解释。

### 5.5 图读模型

```ts
interface GraphNodeView {
  id: string
  kind: 'person' | 'project' | 'event'
  label: string
  subtitle?: string
  weight: number
  reviewStatus?: ReviewStatus
}

interface GraphEdgeView {
  id: string
  source: string
  target: string
  kind: 'relationship' | 'participates_in' | 'involved_in' | 'produces' | 'co_occurs_with'
  strength?: number
  assertionType: AssertionType
  evidenceCount: number
  reviewStatus?: ReviewStatus
}

interface GraphSliceView {
  centerId: string
  nodes: GraphNodeView[]
  edges: GraphEdgeView[]
  nextExpansionTokens: Record<string, string>
}
```

`weight` 和 `strength` 用于排序和布局，不必以分数形式展示给用户。

### 5.6 新增 API

```text
GET /v1/relationships/graph?center=&kinds=&limit=
GET /v1/relationships/graph/expand?token=
GET /v1/relationships/edges/:edgeId
GET /v1/relationships/explore/:preset?params=
PUT /v1/relationships/edges/:edgeId/review
```

服务端返回可视化切片，而不是整库节点和边。

### 5.7 技术任务

1. 从第一、二阶段读模型投影出 `GraphSliceView`，不引入另一套真相数据。
2. 实现中心节点、一层邻居、按需展开和硬上限。
3. 增加图节点/边的权限、校准和证据联结。
4. 桌面端实现图谱 canvas、布局、筛选、搜索和侧边栏。
5. 对 20/50/80 节点进行性能与交互测试。
6. 增加图读模型快照测试，保证用户校准后节点和边正确变化。

### 5.8 验收标准

- 默认图在普通本地数据上可快速打开，不因全量数据卡顿；
- 点击节点可展开一层且总节点数受控；
- 图中人物、项目、事件与列表/详情页使用同一 ID 和同一结论；
- 未确认共现关系不显示为“两人已认识”；
- 任一推断型关系边可查看依据并进行校准；
- 图谱页可顺畅跳转人物档案、项目页和事件证据。

### 5.9 明确不做

- 无限层自动展开；
- 一次渲染整个微信社交网络；
- 仅因两人同在群里就判定关系；
- 利用 AI 推测他人心理、政治、健康等敏感属性；
- 人生全域的 Location/File/Calendar/GitHub 节点。

---

## 6. 三阶段交付摘要

| 阶段 | 核心交付 | 验证的产品假设 | 主要技术增量 |
|---|---|---|---|
| 第一阶段 | 单人关系档案、事件、待跟进、证据、校准 | 从聊天生成的人物关系知识是否真实有用且值得信任 | 统一人物读模型、校准 overlay、内部 API |
| 第二阶段 | 人物中心、待跟进中心、最近变化、共同项目 | 多人知识能否成为用户日常的关系工作台 | 全局索引、趋势计算、项目消歧、变化事件 |
| 第三阶段 | 人—项目—事件关系图与探索查询 | 空间化视图能否帮用户发现列表中难以看到的关联 | 图投影读模型、切片 API、增量展开、图交互 |

## 7. 建议的开发切片

不建议以“后端全做完→前端全做完”的方式开发，而应按可演示的纵向切片交付。

### Slice 1：真实联系人的最小档案

- 选择一人；
- 拉取 `person_brief`；
- 显示人物概要和 3–5 条事实；
- 可查看一条原始消息证据。

### Slice 2：校准闭环

- 确认/修改/否定事实；
- 保存 overlay；
- 重新分析后保留用户结论。

### Slice 3：事件和待跟进

- 时间轴；
- obligations 分类；
- 完成/忽略操作；
- 证据回溯。

### Slice 4：多人首页

- 人物摘要索引；
- 排序、筛选和分页；
- 从列表跳转已有人物详情。

### Slice 5：项目与关系变化

- 轻量 ProjectView；
- 月度趋势；
- 可解释的 RelationshipChange。

### Slice 6：最小可用图谱

- 以我为中心；
- 仅 Person + Project；
- 20 节点内；
- 点击节点打开已有详情。

### Slice 7：事件节点与按需展开

- Event 节点；
- 一层展开；
- 关系边详情；
- 图视图性能收口。

## 8. 成功指标

不建议一开始以“节点数”作为核心指标。更有价值的是：

### 第一阶段

- 生成档案的用户中，查看证据的比例；
- 每份档案被确认、修改、否定的结论数；
- 待跟进被完成或忽略的比例；
- 用户是否主动对第二个人生成档案。

### 第二阶段

- 人物中心的重复访问；
- 跨人物待跟进完成量；
- 从“最近变化”进入人物详情的比例；
- 项目合并/拆分的校准率。

### 第三阶段

- 用户在图中展开节点、打开边详情或跳转档案的比例；
- 图谱帮用户发现并确认新关联的数量；
- 不同节点规模下的加载与交互性能；
- 图谱页是否促进人物档案和待跟进的使用，而不是只被看一次。

## 9. 需要在第一阶段开发前锁定的决策

1. **联系人主键**：明确 wxvault、wxgraph、wxfacts、wxsearch 共用的稳定 person ID，禁止使用显示名作为唯一键。
2. **证据打开方式**：是在 WeChat CC 内展示本地聊天上下文，还是尝试定位到微信客户端。第一版建议前者。
3. **校准所有权**：确定 WeChat CC SQLite 为用户修正的权威层，插件派生库保持可重建。
4. **模型使用边界**：数值指标由确定性代码计算；LLM 只负责事实提取、实体候选和自然语言概要。
5. **群聊边界**：第一、二阶段只分析一对一聊天；群聊和第三方隐私单独立项。

## 10. 结论

三个阶段的正确依赖顺序是：

```text
可信的单人档案
       ↓
可日常使用的人物中心
       ↓
可探索的关系网络
```

如果第一阶段的证据、校准和实体身份没有建稳，第三阶段的图只会放大错误。反过来，只要前两阶段已经积累了稳定的人物、项目、事件和用户校准，第三阶段主要是一个图投影和交互问题，不需要重新建造数据底座。
