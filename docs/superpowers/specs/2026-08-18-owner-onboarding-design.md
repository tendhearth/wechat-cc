# Owner Onboarding(从扫码到养成)— 设计

日期:2026-08-18
状态:已评审(目标用户与主动性尺度经用户拍板;现状调查见 §0)
定位:roadmap 4b 点名的最后一块未动工项("该段 onboarding"),且 roadmap
自己的判断成立——**这是拼装,不是新造**。

## 0. 现状调查结论(2026-08-18,dev@841b31a7 逐行核实)

机械件全齐:两步称呼状态机 + echo 重派发(onboarding.ts)、admin 对话式起
bot 名、分节 /help、四档 /set 偏好、把主动接触锁到结构性安全的 calibration
门、两个已上线的 prompt 级 onboarding 机制(刚认识 curiosity + persona 空库
nudge)、companion_enable 的 welcome 文案、配对码全套。缺的全部是连接组织:

- **F1(bug)**:终端安装的 owner 落 guest tier——`setup-flow.ts:268-278`
  只写 `allowFrom`;`resolveTier` 无 allowFrom 回退(`user-tier.ts`),而
  `isAdmin` 有回退(`access.ts`)⇒ owner 看得到 admin 的 /help 区块、被问
  bot 起名,却调不动 Bash/Edit/companion_enable。桌面路径 `--dangerously`
  掩盖;doctor 不查。
- **F2**:owner 收到的第一条消息是 pid dump + ⚠️ 警告(notify-startup.ts:88)。
- **F3**:onboarding 状态 in-memory(onboarding.ts:72,19-22),重启失忆重问
  ——self-restart 上线后窗口变大。
- **F4**:/help 落后两个 provider(/agy /gemini 缺);未知斜杠命令静默透传
  给 LLM 变 prose(mode-commands.ts:580-582)。
- **F5**:开场问称呼但从不说自己是什么、能干嘛,也从不指路 /help。
- **F6**:养成无点火——companion 三重锁死(enabled:false + default_chat_id
  null + care off)且无任何时机提议开启;表情包冷启动死锁(空库 ⇒
  stickerSection 不渲染 ⇒ 模型不知道 save_sticker 存在 ⇒ 库永远空,
  main.ts:302 + prompt-builder)。

**已定决策:**
1. 本轮只做 **owner 侧**(部署者从扫码到养成);guest 路径(申请-录取流、
   owner 通知、加好友摩擦)下一轮;
2. 主动性 = **温暖开场 + 自然时机提议**;维持 onboarding-curiosity spec 的
   non-goal(不做脚本化问卷、不做主动引导序列)。

## §A 修直的(bug/卫生)

### A1. tier 引导修复(F1)

- `src/cli/setup-flow.ts` 绑定首账号时,除 `allowFrom.push` 外同步写
  `admins: [ilink_user_id]`——**仅当 `admins` 当前为空/缺失**(已有 admins
  的老安装绝不动;第二账号绑定同理不动)。
- `src/cli/doctor.ts` 新增检查:`allowFrom` 非空而 `admins` 空 ⇒ 警告 +
  修复指引(把哪个 user_id 填进 admins;指出症状:工具全被 guest 档拒)。
  存量安装靠 doctor 提示修复,不做自动迁移(改 access.json 是权限变更,
  必须让人确认)。
- `isAdmin` 与 `resolveTier` 的语义差异**保留**(isAdmin 的 allowFrom 回退
  是单用户早期安装的兼容层),各自注释补一句指向本 spec。

### A2. onboarding 状态落盘(F3)

`onboarding.ts` 的 in-memory `Map` → `makeStateStore`(仓库既有写透惯例,
`debounceMs: 0`,tmp+rename)持久到 `<stateDir>/onboarding-pending.json`。
语义不变:30 分钟超时照旧(时间戳入盘,读取时过滤过期项),1.5s 去重窗口
仍在内存(进程内语义,无须耐久)。重启后进行中的称呼问答自然续上。

### A3. 发现性止血(F4)

- `/help` 的模式切换行补 `/gemini` `/agy`(与 /mode 的清单对齐;后续新
  provider 上线时两处同步是 checklist 项,注释注明)。
- 未知纯斜杠命令:形如 `/^\/[a-zA-Z]{2,16}$/`(单词、无参数、非已知命令)
  ⇒ 回复 `❓ 不认识 /xxx。看全部命令发 /help。` 并**消费**(不再透传 LLM)。
  刻意窄:带参数或含中文/空格的照旧透传(用户可能真在说话);已知命令
  前缀不受影响。
- `/set` 裸用法的四档枚举已够好,不动。

### A4. 首启通知人性化(F2)

`notify-startup.ts`:state 里加一次性标记(`startup-notified.json` 或并入
现有 state-store 键)。**首次**通知 owner 用温暖版:
`我上线啦 👋 直接跟我说话就行;想看我能干嘛,发 /help。`
之后每次重启保留现有技术版(pid/accounts/strict 警告)——owner 是技术人,
重启信息有运维价值。

## §B 开场叙事

### B1. turn-1 文案:一句自我介绍 + 问称呼(F5,仍是一条消息)

`onboarding.ts:248-251` 的文案改为:
`你好呀!我是 ${botName}——住在你微信里的 AI 伙伴,能聊天、帮你干活、记得你说过的事。先问一下,我应该怎么称呼你?比如「Nate」「丸子」(中文/英文都行)`

### B2. turn-2 收尾一次性指路 /help

`onboarding.ts:111-118` 的确认句改为:
`好的 ${nick}!想看我全部玩法,随时发 /help。刚才你说「${triggerText}」,回答下:`
echo 重派发机制、admin 起名子步、校验文案全部不动。

## §C 养成点火(prompt-level,非问卷)

### C1. 陪伴提议时机(F6 前半)

`prompt-builder.ts` 新增 `companionOfferSection()`,注入条件(全部满足):
- 该 chat 是 owner chat(admin 判定,与 personaFor 的 owner 判定同源);
- companion 未开启(`loadCompanionConfig().enabled === false`);
- 该 chat 入站消息数 ≥ `NEW_RELATIONSHIP_MSG_COUNT`(已过"刚认识"期——
  刚认识 section 和提议 section 天然互斥,不会同屏)。

内容一句话级:"你们已经聊熟了;若对话自然聊到未来的事(约定/截止/日程),
可以顺势提一句你能主动关心这些(工具 companion_enable),对方同意才开启。
提过一次没被接受就别再提。" 开启后条件不满足,section 自动消失。
接线走 bootstrap 的既有 per-spawn thunk 姿势(careLevelFor 同族)。

### C2. 表情包冷启动解锁(F6 后半)

现状:`main.ts:302` 空库 ⇒ `allTags()` 为空 ⇒ `stickerSection` 不渲染。
改:`prompt-builder.ts` 的 sticker 部分增加**空库版**(渲染条件:pref on
且库空):"你还没有表情包;聊天里遇到值得存的表情/梗图,可以用
save_sticker 存进库,以后就能用了。" 非空库行为不变。

### C3. persona 空库 nudge 已上线,零改动。

## §D 测试策略

- A1:setup-flow 单测(首绑写 admins 仅当空;二次绑定不动)+ doctor 用例;
- A2:onboarding 单测改造(注入 store;重启模拟 = 新实例同 store 续问答;
  过期项过滤)+ e2e 补一条:问称呼 → daemon 重启(harness stateDirOverride
  双 boot 姿势)→ 回昵称 ⇒ 正常续流程不重问;
- A3/A4/B1/B2:文案与消费行为单测(mode-commands / notify-startup /
  onboarding 各自套件);e2e 现有 onboarding 用例的期望文案同步更新;
- C1/C2:prompt 组装断言(bootstrap 单测既有模式:条件满足 ⇒ section 出现,
  companion 开启/库非空 ⇒ 消失);
- 全量 unit + e2e 回归(容忍本机 2 个已知插件符号链接失败)。

## §E Non-goals(显式)

- guest 路径:申请-录取流、owner 通知被拒消息、加好友的非 JSON 手术路径
  (下一轮,依赖本轮 owner 体验跑顺);
- 临时网页设置面板(liveness 文档的构想);
- 显式引导序列 / 问卷(既定 non-goal 延续);
- 配对码/社交功能的开场推销;
- `NEW_RELATIONSHIP_MSG_COUNT` 30→50 漂移:保持 30(onboarding-curiosity
  spec 的 50 是笔误级漂移,以代码为准,该 spec 注一句);
- 桌面 UI 任何改动(keep-desktop-ui-simple)。
