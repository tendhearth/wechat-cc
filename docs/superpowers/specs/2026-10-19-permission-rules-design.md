# 放行规则:CC 一张表管所有执行者的权限请求 —— 设计草案

> 2026-10-19 · 状态:**待主人拍板设计**(方向主人 10-19 说「是的」;本稿拍板之前不写代码)。
> 标 **[我的判断]** 的是我替主人定的默认,主人读的时候重点看这些。
> 已过一轮「照着这份能不能开工」的读稿检查(10-19),问出来的五条都在正文里答了。

## 为什么

CC 要当「大总管」(主人 10-14):底下的 Claude Code / Codex / Cursor / agy 是手,CC 管派活、看进度、拍板。
前两样已经有了(终端会话登记处、看着它跑、一起做);**拍板现在是三套各管各的**,而且没有一套是 CC 在拿主意:

- 终端会话(hook 中继):主人不在时只是把问题原样转到微信 / 手机 / App,没有任何规则。
- 一起做(工作台):每一步都要主人点,5 分钟不点就拒;agy / Cursor 编辑是另一个极端 —— 一次确认后全免审。
- 对话侧:按身份档(admin / trusted / guest)+ 一条破坏性命令正则,硬编码。

结果是主人要么被一堆「要读 package.json 吗」打断,要么整把放开。对标:OpenAI dots 的 Custom Rules(每类动作四档:直接做 / 你交代过才做 / 先问 / 交给你)+ Auto-review(风险动作对照主人规则再审一遍)+ 固定红线(改密码之类永远归你)。

**成功的样子**:主人一天被问的次数明显变少,而被问到的都是真该问的;CC 替主人批过的每一条都看得见、改得了规则。

## 目标 / 不做 / 反目标

目标
1. 一张主人的规则表,两处现有的权限入口(终端会话、一起做)先问它(见「挂在哪」)。
2. 规则没覆盖到的,便宜模型对照主人规则 + 这件事的原始交代初审一遍,只能在「低风险类」里自己放行,其余照常问主人。
3. 每一条不是主人亲手批的决定都留痕,日报里看得见,一键改成「以后问我」。

不做(这一版)
- 不改自改流水线(永远主人拍板)、A2A 执行、访客申请、免审执行者(agy / Cursor 编辑,它们没有逐步请求可拦)。
- 不替终端自己的允许列表(`~/.claude/settings.json` 那份)做决定 —— 主人在终端前时终端自己问,照旧。
- 不自动生成规则(只建议,见第 6 节)。

反目标(做成这样就算失败,哪怕能跑)
- CC 替主人批了一条事后才知道、而且找不到记录的。
- 模型能把「固定红线」里的东西放行。
- 网络不安全时为了初审去调官方端点(违反网络守护 / 封号红线)。
- 访客 / trusted 会话借这张表拿到自动放行。

## 挂在哪(三个入口,一个判定函数)

现状勘察(10-19,file:line 以 dev bf28dbbf 为准):

| 入口 | 今天在哪拍板 | 挂点 |
|---|---|---|
| 终端会话 hook(Claude Code / Codex;主人不在时) | `src/core/cli-permission-relay.ts:108` `open()`,在场判断之后开码 | `open()` 里、开码之前 |
| 一起做(Claude SDK / Codex app-server / Cursor ACP / API 执行者) | `src/core/workbench/permissions.ts:44` `request()`,5 分钟到期按拒 | `request()` 里、登记之前 |
| ~~对话侧 Claude / Gemini~~ | `src/core/permission-relay.ts:29`(Gemini 另有一份内联副本 `gemini-agent-provider.ts:251`) | **v1 不挂** |

**[我的判断] 对话侧 v1 不挂**:admin 在对话里只有三类会问主人(`user-tier.ts:85`:破坏性 shell、删记忆、自修复),破坏性 shell 本来就在固定红线里,剩下两类本就该问 —— 挂上去几乎没有收益;trusted / guest 按反目标又不能进表。借规则表放宽 admin 的 relay 集合是另一件事,另议。

新增一个纯函数模块 `src/core/permission-rules/`:

```ts
decide(req: {
  surface: 'terminal' | 'workbench'
  provider: string            // claude / codex / cursor / …
  tool: string                // Bash / Edit / commandExecution / fileChange / mcp:<server>:<tool> …
  command?: string            // shell 命令原文(有就给)
  paths?: string[]            // 涉及的文件(有就给)
  cwd: string | null
  project: string | null      // cwd 归一到的项目根
  intent?: string             // 这件事 / 这条会话主人最初交代的那句话
  tier: 'admin' | 'trusted' | 'guest'
}): Promise<{ verdict: 'allow' | 'ask' | 'deny'; by: 'rule' | 'review' | 'floor' | 'default'; ruleId?: string; reason: string }>
```

`ask` ⇒ 走各入口今天的老路(开码 / 登记 / 问主人),**一行不改**。`allow` / `deny` ⇒ 直接回执行者并写一条记录。

前置改动:
- 一起做的 `SpawnContext.requestPermission`(`src/core/agent-provider.ts:282`)今天只传 `{tool, description}`,要加可选的 `command` / `paths` / `cwd`;各执行者能给就给,给不了的规则只能按 tool 匹配(不猜)。
- 终端 hook 今天只传压缩过的 `summary`(`src/cli/hook.ts:124`),要加 `command`(Bash 原文,截 2000 字)与 `paths`。
- **终端这条路必须异步判**:hook 发 POST `/v1/cli/permission` 只等 5 秒(`hook.ts:314`),而且返回的不是 `pending` 就当「没决定」交还终端(`hook.ts:318`)—— 老 hook 收不到直接的 allow / deny。所以 `open()` 照旧立刻回 `pending` + 码,`decide()` 在后台跑:结果 `allow` / `deny` ⇒ 马上把这个码 settle 掉(hook 下一次 GET 就拿到),**不发**微信 / App 通知;结果 `ask` ⇒ 才走今天的发码通知。规则命中是同步的、几毫秒,只有初审要等;等初审期间不发通知,初审超时 8 秒 ⇒ 当 `ask` 发通知。

**缺字段时 [我的判断]**:请求没带 `command`(Bash 类)或没带 `paths`(写文件类)⇒ 只有 `deny` / `ask` 规则能命中,`allow` 规则与初审一律不放行(= ask)。只凭 tool 名永远放不了写或 shell。

**项目根 [我的判断]**:一起做 = 这件事的独立工作区目录(没开独立工作区就是任务的项目路径);终端会话 = cwd 的 `git rev-parse --show-toplevel`(realpath 归一,Windows 用 `realpathSync.native`);取不到(不在仓库里、在 `~` 下起的)⇒ `project = null`,没有任何「项目内」待遇,写类一律 ask。

**谁算主人的(admin)[我的判断]**:终端会话 = 本机 hook 报来的(`machine` 是本机、不是脑手转发进来的);一起做 = 任务由桌面 / 配好的手机设备令牌 / 主人自己的微信 chat 发起,其它来源(trusted 的微信、A2A 委派)⇒ 不进表。实现者先核实任务记录里现有的来源字段可信,不可信就先补字段,补齐之前一起做这条路不启用。

## 1. 规则表

存在状态目录 `permission-rules.json`(与 `agent-config.json` 同级,原子写)。**[我的判断]** 用 JSON 不用 SQLite:规则少(几十条)、要能被主人 / CC 直接读改、要跟着备份走。

```jsonc
{ "version": 1, "enabled": false, "review": "off" | "low_risk",
  "rules": [
    { "id": "r1", "when": { "tool": "Bash", "command": "^(npm|bun|pnpm) (test|run test|run typecheck)\\b" }, "then": "allow", "note": "跑测试不用问" },
    { "id": "r2", "when": { "tool": "Bash", "command": "\\bgit push\\b" }, "then": "ask" },
    { "id": "r3", "when": { "project": "~/Documents/tendhearth/wechat-cc", "tool": "Edit" }, "then": "allow" }
  ] }
```

- 匹配维度:`surface` / `provider` / `project`(前缀,按 realpath 归一)/ `tool`(精确或 `mcp:server:*`)/ `command`(正则)/ `paths`(glob,**全部**涉及的路径都要命中)。
- `then`:`allow` / `ask` / `deny`。dots 的「你交代过才做」并进初审(第 2 节),不单列一档。**[我的判断]**
- 顺序:`deny` 规则先于 `allow`(同一请求两条都命中 ⇒ 拒);其余按表内顺序第一条命中。
- 总开关 `enabled` 默认 **false**:装上什么都不变,主人打开才生效。

## 2. 初审(规则没命中时)

只在 `review: "low_risk"` 且请求属于**低风险类**时跑;其余没命中的一律 `ask`(= 今天的行为)。

低风险类(代码判,不问模型)**[我的判断]**:
- 只读:读文件、列目录、grep / rg / ls / cat / git status|diff|log、跑测试 / typecheck / lint;
- 在**这件事自己的独立工作区 / 项目目录内**写文件(路径全部在 project 根下,且不在固定红线里)。

初审 = 一次便宜模型调用(`cheapEval`,同伙伴日程判断那套):给它主人的规则表 note、这件事的原始交代 `intent`(一起做有;**终端会话 v1 没有**,登记处只存 `last_summary` —— 所以终端会话的初审只管只读类,写文件一律 ask **[我的判断]**)、请求本身,只许回 `allow` 或 `ask` + 一句理由。**模型不能回 deny,也不能放行低风险类之外的任何东西**(代码在模型之前就把这些挡成 ask)。

闸门(都不过 ⇒ 直接 `ask`,不调模型):
- 网络守护说这次调用不安全 ⇒ 不初审(`decideCall`,同 relay / resume)。
- 没有可用的便宜模型 / 额度冷却中 / 断线 ⇒ 不初审,而且按现有退避,不重试。
- 只给 admin 会话(主人自己的终端会话、主人建的一起做、主人的对话)。trusted / guest **永不**进规则表和初审,照旧。
- 初审超时 8 秒 ⇒ `ask`。

## 3. 固定红线(规则和模型都改不了)

代码里写死,`decide()` 第一步就判,命中一律 `ask`(主人亲手批,不能被 allow 规则覆盖;deny 规则仍可生效):
- 写或删项目根之外的任何路径;`rm -rf` / `git clean -fdx` / `git reset --hard`(沿用 `user-tier.ts:222` 的破坏性正则并扩充);
- `git push` / `npm publish` / 发版 / 部署 / `wechat-cc self deploy`;
- `sudo`、改系统配置、`launchctl`、改 shell 配置文件;
- 读写密钥:`~/.ssh`、`~/.private_keys`、`.env*`、钥匙串、`*.p8` / `*.pem`;
- 网络外呼类工具(curl / wget 到非本机地址、发邮件、发消息)—— 对齐「不做无人值守自动外呼」;
- 改 `permission-rules.json` 本身、改 `agent-config.json` / `access.json`。

## 4. 留痕与撤回

- 新表 `permission_decisions`(迁移 +1,按迁移位置契约改三处测试):时间、入口、provider、项目、tool、命令摘要(截 200 字,密钥形态先打码)、verdict、by、ruleId、理由、会话 / 任务 id。只记不是主人亲手拍的(`rule` / `review` / `floor` 的 deny);主人亲手批的已有各自的记录。保留 30 天。
- 日报(`/v1/overseer/today`)加一行:「CC 替你批了 N 条(规则 M、初审 K)」,点开是列表。
- 每条后面一个动作:「以后问我」⇒ 在规则表最前面加一条精确匹配的 `ask`。执行过的动作撤不回,这里撤的是规则,文案要说清楚。
- **[我的判断]** 初审放行的那一刻不推送(推送就失去了少打扰的意义),只进日报;但同一件事 10 分钟内初审放行超过 20 条 ⇒ 这件事后面的改回 `ask` 并告诉主人一次(防一路放行)。

## 5. 入口(主人怎么改规则)

**[我的判断]** v1 只做两处,不加桌面新面板(既定「桌面保持简单」):
- 微信 / 对话:「以后跑测试不用问我」「push 之前都要问我」⇒ CC 翻译成一条规则,回显给主人确认后才写入(写规则本身是固定红线里的一项,只能经主人确认)。
- 被问到时的卡片(微信 y/n 码、手机、App、桌宠)多一个选项「允许,以后这类都不用问」⇒ 生成一条精确规则(同 tool + 同命令前缀 + 同项目),回显规则原文。

`wechat-cc rules list|add|rm` CLI 给维护者用。

## 6. 学(只建议,不自动)

同一项目里主人对同一类请求(tool + 命令前缀)连续批准 3 次 ⇒ 下一次的卡片上直接给「以后这类都不用问」并写出规则原文。不自动写规则。

## 超时与默认值(不改)

两处入口超时后的默认各不相同(终端 hook 交还终端、一起做按拒),这一版**都不动**;`decide()` 只在它们问主人之前插一步。

## 测试要钉住的

- `enabled: false` ⇒ 两处入口行为逐字节不变(现有测试全过即证明)。
- 终端:规则 allow ⇒ 码立刻 settle、不发通知;初审跑着时 hook 的 POST 仍 5 秒内回 pending。
- 缺 `command` / `paths` 的 Bash / 写类请求,有 allow 规则也是 ask。
- 固定红线:每类一条,即使有 allow 规则 / 初审回 allow 也是 ask。
- trusted / guest 请求从不调初审、从不按规则放行。
- 网络守护不安全 ⇒ 不调模型。
- 初审只能回 allow / ask;回别的 / 超时 / 抛错 ⇒ ask。
- 每条非主人决定都写进 `permission_decisions`;命令里的 token 形态被打码。
- 一件事 10 分钟内 > 20 条初审放行 ⇒ 后续 ask + 一次通知。

## 留给实现者定的

- 规则正则的安全子集(防灾难性回溯:限长 + 超时或改用前缀 / glob)。
- 各执行者能提供的 `command` / `paths` 字段怎么从各自的请求里取。
- 规则表文件损坏时:当作 `enabled: false` 并在「CC 现在怎么样」里报一条。

## 要主人定的(按重要性)

1. **初审要不要做**:还是 v1 只做规则表(主人写了才放行,模型不参与)。我建议做,但默认关(`review: "off"`),主人试一周规则表再开。
2. **低风险类的边界**:「在这件事自己的项目目录里写文件」算不算低风险。算的话,一起做里大部分「要改 X 吗」都不用问了;不算的话初审只管只读。
3. **初审放行要不要实时告诉你**:我建议只进日报。
