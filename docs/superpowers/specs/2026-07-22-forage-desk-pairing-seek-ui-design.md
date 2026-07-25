# 觅食台补齐配对 + 派心愿确认门(桌面纯前端)设计

**日期**: 2026-07-22
**状态**: 已批准(方案一:两期走的第一期;笔友信箱另立项)
**父级脉络**: `2026-07-15-forage-desk-agent-page-design.md`(P3 页面)、`2026-07-20-pairing-code-design.md`、`2026-07-20-p4-seek-confirm-design.md`

## 背景与目标

配对码(pair/start + pair/accept)和派心愿确认门(seek propose/confirm/cancel)已随 PR #74 进 master,但只有 CLI 和微信入口——桌面觅食台页完全看不到。本期把这两块接进觅食台,**纯前端**:后端路由已齐(全部 trusted 级,桌面 admin token 覆盖),零后端改动。

笔友信箱**明确不在本期**:`penpal_letter` 无 internal-api 路由,需要先做后端定级评审,另立项。

## 改动面

- `apps/desktop/src/modules/a2a-agents.js`(主要)
- `apps/desktop/src/index.html`(新增静态骨架)
- `apps/desktop/src/styles.css`(沿用 `fd-` 前缀类 + pane 级 `--fd-*` 变量,不碰全局 token)
- `apps/desktop/src/modules/a2a-agents.test.ts`(模块测试)
- **不动** `main.js`(`initA2AAgentsTab`/`refresh` 导出签名不变)、不动后端。

## ① 心愿区:propose → 预览卡 → 确认

§①心愿 现为只读列表,增加:

1. **输入行**:心愿内容(必填)+ 城市(可选)+ "派出去"按钮 → `POST /v1/social/seek/propose {topic, city?}`。
2. **脱敏预览卡**:propose 返回 `{ok:true, intent_id, redacted, redacted_city?}` → 渲染"🕶️ 外面只会看到这个"卡片,只显示 `redacted` / `redacted_city`,附 确认 / 取消 按钮。
   - 确认 → `POST /v1/social/seek/confirm {id}` → 成功后清空预览、刷新列表(状态进入觅食中)。
   - 取消 → `POST /v1/social/seek/cancel {id}` → 清空预览、刷新列表。
3. **列表联动**:`GET /v1/social/seeks` 里 `status === 'proposed'` 的行渲染同样的 确认/取消 按钮 —— 微信/CLI 发起的提案可在桌面确认;页面刷新不丢待确认提案。`cancelled` 行按既有状态样式惯例灰显。

**隐私锁(测试断言)**:预览卡与 proposed 行只读 `redacted*` 字段,绝不渲染原始 `topic` 旁路——与 P3 明信片只读 `PublicEchoRow` 同一纪律。

## ② 觅食网区:配对入口

放在 §③ 觅食网折叠区顶部(配对产出一条新边,归属自然),两个动作:

1. **生成配对码** → `POST /v1/pair/start` → `{ok:true, code, expiresAt}`:大字号显示 6 位码 + 基于 `expiresAt` 的倒计时,文案"念给朋友,对方在他的觅食台(或 `wechat-cc pair <码>`)输入"。
   - 完成是异步的(后端轮询引擎收边);码展示期间前端每 ~15s 刷新 agent 列表,列表出现新条目即提示"配对成功:<名字>"并收起码面板;倒计时归零自动收起。
   - `{ok:false, reason:'relay_drop_failed'}` → "中继暂时联系不上,稍后再试"。
2. **输入朋友的码**:6 位数字输入(前端校验 `/^\d{6}$/`)→ `POST /v1/pair/accept {code}` → 同步结果:
   - `ok:true` → "已和 <peer.name> 成为笔友网络邻居",刷新 agent 列表。
   - 失败原因映射:`expired_or_wrong` → 码不对或已过期;`self_pair` → 不能和自己配对;`id_conflict` → 对方名字与已有朋友冲突;`relay_drop_failed` → 中继不可达。

## ③ 错误处理

- `503 {error:'social_not_wired'|'pairing_not_wired'}` → 该区块显示引导文案:先在命令行运行 `wechat-cc social enable` 并重启守护进程。
- 网络/其余错误:沿 P3 reveal 的非崩溃分支模式,就地显示短错误文案,永不白屏;按钮 pending 期间禁用防双击。
- 倒计时等定时器在 pane 切换/刷新时清理,不泄漏。

## 测试

沿 `a2a-agents.test.ts` 现有模块测试套路(jsdom 级渲染 + stub `invokeApi`):

- propose 成功 → 预览卡出现且只含 redacted 字段(隐私断言:原文不出现在 DOM)。
- confirm / cancel 各自的成功与失败分支。
- proposed 行渲染确认/取消按钮;cancelled 行不渲染。
- pair/start 成功(码 + 倒计时)与 relay_drop_failed;pair/accept 四种失败 reason 的文案分支 + 成功分支。
- 503 两种 not_wired 的引导文案。
- 现有 18 个测试不回归;`initA2AAgentsTab` 导出签名不变。

desktop-e2e:不受影响(agent 列表仍在原 `<details>` 内,改动纯增量);该 CI 本就非必需红,不追。

## 非目标

- 笔友信箱读/写(需新后端路由,另立项)。
- 心愿区实时推送(维持现有手动/进页刷新 + 配对期间的临时轮询)。
- 微信/CLI 侧任何改动。
