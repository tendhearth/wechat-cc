# CC 更活：有依据的注意力与回应

2026-11-08。负责人/唯一写入者：Codex；工作区 `wt-cc-alive-codex`，分支 `cc-alive-r1`，起点 `origin/dev` = `5d3410e39c44bf2c059a0e5eaffad7a052c15f95`。本批只开发、离线验证、提交，不推送、不部署。研究为公开页面/影片资料阅读，未安装体验竞品；下文所有毫秒与频率是 **CC 的设计参数**，不是竞品实测数据。

## 目的与边界

用户不必读状态句，也能看出 CC 正在注意输入、处理回复、输出新内容，或者刚带回结果。动作同时是可信的功能反馈。保持一个 CC、一张暖纸、全衬线与既有强调色。明暗只表达真实连接：已确认在身边才亮，演示/未同步/断线为暗；动作不得用亮度制造另一种含义。

继承 [10-29 动作扩充](2026-10-29-cc-motion-expansion-design.md)、[第二轮素材](2026-10-30-cc-materials-round-two-design.md)、[道具收尾](2026-10-30-cc-prop-polish-design.md)、[桌宠感](2026-11-01-cc-desktop-pet-feel-design.md)、[上下文](2026-11-01-cc-pet-context-design.md)、[生活](2026-11-02-cc-pet-life-design.md)、[表演](2026-11-03-cc-motion-performance-design.md)、[好奇心](2026-11-03-cc-pet-delight-design.md)、[手机反馈](2026-10-24-phone-motion-feedback-design.md) 与 [素材生产合同](2026-09-08-cc-asset-production-brief.md)。不重做已有连续动作、道具、转面或随机生活系统。私有设计板不复制进仓库。

CC 仍是一个 C、两眼两脚，无嘴、耳、手、尾。没有真实音频就不做口型；文本回应与声音播放分别建模。不新增“心情”数据库，不分析主人正文来假装共情，不因离开时间变暗、失落、催回来。

## 公开研究：事实、取舍与限制

| 对象与来源 | 能确认的具体手法 | 对 CC 的转译 / 要避开的坑 |
| --- | --- | --- |
| Meta Muse [11 月官方发布](https://about.fb.com/news/2026/11/introducing-muse-ai-voice-expressive-avatars/) | 听与说有不同反应，表情/手势配合交谈；头像呈现强度可选 | 输入注意与输出分开；存在感可减。不能仅凭请求已发送就开始思考表演 |
| Muse [技术说明](https://research.meta.ai/blog/bringing-your-muse-to-life) | 语音与头像共用 speech-token 流，连续运动上下文保持衔接 | 一个真实事件源驱动相关动作；中断立刻生效；不另造随机口型 |
| Muse [设计者说明](https://introducing-muse.com/) | 头像下是实际工作摘要，点开可看活动；主动消息只在有意义的新结果或需要输入时出现，主动性可调 | 角色依附功能入口；新话题看一眼，不循环招手；保留用户自己的时间 |
| OpenAI dots [官方介绍及影片](https://openai.com/index/introducing-dots/) | 一个 dot 可跨聊天/消息入口持续协作；抽象形象出现在工作入口 | 同一个 CC 跨端用同一语义。公开资料不足以还原 dots 动画状态机，不声称知道其眨眼间隔 |
| dots [发布报道](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/) | 泡泡式抽象头像，而非逼真人物 | 借鉴轻形变/停顿，保留 CC 自己的 C 轮廓；不复制角色配色或装饰 |
| Grok Ani/Rudi，**2025 年历史案例**：[发布报道](https://www.itmedia.co.jp/aiplus/article/2507/15/1250715083/) | 声音、3D 角色和个性绑定，角色以不同态度回应 | 一致的动作习惯比更多服装重要。没有可靠 xAI 一手资料确认精确状态机/频率；不推断当前可用性 |
| Grok [TIME 报道](https://time.com/7302790/grok-ai-chatbot-elon-musk/) | Ani 的亲密/性化互动引起依赖与边界争议 | 不做吃醋、好感度、索要安慰、责备离开；“更活”不能变成要求主人照顾角色 |
| Pi [设计团队 ustwo 案例](https://ustwo.com/work/inflection-ai/) | 安静界面、Discover 话题与语音交谈共同形成伙伴感 | 话题是可忽略的邀请；不需要持续全身表演 |
| Replika [官方通话更新及原始用户反馈](https://www.reddit.com/r/ReplikaOfficial/comments/1ggdydv/exciting_update_a_new_replika_call_experience_on/) | 角色可走动交谈；有用户把无目的走动理解成烦躁或想结束，团队回应会调整表情 | 随机动作会被读成意图；待机保持中性，失败不演失落让用户来安慰 |
| Duolingo [官方工程/设计说明](https://blog.duolingo.com/world-character-visemes/) | 基础姿态、口型分层；待机眨眼/点头；结果反应由答题结果控制；音频被打断时动画同时停 | 沿用少量稳定动作层；真实结果才庆祝，中断不排队补演。CC 无嘴，不照抄 viseme |
| Siri [Apple 功能说明，p.4](https://www.apple.com/in/ios/ios-18/pdf/iOS_18_All_New_Features_Sept_2024.pdf) | 交互光随用户声音响应，交互期间内容仍可见 | 未来用录音/播放振幅驱动小幅形变；CC 的光只保留连接语义，不能复制成工作光球 |
| Rabbit [交互说明](https://www.rabbit.tech/support/article/use-rabbit-r1)、[官方发布](https://www.rabbit.tech/newsroom/introducing-r1) | 按键、睡眠/唤醒、PTT 聆听各有明确输入边界 | 按住收音才听，松开/取消即停止。睡眠来自真实生命周期，不按夜间时钟猜 |
| Humane [发布采访](https://time.com/6333416/humane-ai-pin-launch/) | Trust Light 跟麦克风/相机使用状态相关 | 状态反馈必须可被信任；不借鉴它的硬件前提或替 CC 添加传感器能力 |
| [视线行为综述](https://graphics.cs.wisc.edu/Papers/2015/RPABBGMM15/Ruhland_et_al-2015-Computer_Graphics_Forum.pdf) | 眼/头的注意力动作影响交流感；外观与行为不匹配会让人不适 | 输入时关注输入处、话题出现看话题，再回中；不追逐全屏鼠标，不模拟读懂用户情绪 |

公开资料没有足够可靠的“多久动一次才不烦”数值，也没有统一出场/告别协议。本设计按 CC 常驻、小尺寸、工作时长来定预算，后续由长期使用观察调整。[Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion)、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[WCAG 交互动画](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions) 支持让动效有目的并可减少。

## 对照 CC 现状

| 端 / 层 | 已有，不重做 | 缺口与本次处理 |
| --- | --- | --- |
| 桌宠 `pet` | 13 个行为、双态连续帧、真实 pet phase、权限优先、done/receive、高水位去重、生活/工作/好奇心、安静与减动 | 有 thinking/working，无文字输出短窗；本批消费既有 owner-events，只读、串行、可停，不碰 daemon。输入仅在本机窗口间传短暂布尔值，不传正文 |
| 桌面对话/主页 `now-hero` | 同一素材/状态机、任务结果边沿、隐藏/恢复基线 | 本地 pending 过去直接演 thinking：收紧为明确 running 才演。复用对话页既有事件 reader，不增加该页网络流；话题条新 id 才看一眼 |
| App `CCFigure` | canonical 两图、4s 呼吸、receive 440ms、done 640ms、wait 360ms、连接淡变、焦点/前台/减动控制 | 加听/想/回应代码姿态；复用 screen 已持有的 stream。back 组含失败/停止，必须按 `replied/done` 筛选才能进入完成动作 |
| 网页/PWA | `setPresenceLit()` 与两图透明度，真实同步控制明暗 | 暂无动作 tracker/流事件 reader/输入租约；第二批再接共享合同，不能先塞无条件 CSS 循环冒充三态 |
| 美术 | 已有 listening 研究姿态、thinking/look/done/working 与 9 种表演候选 | 第一批无需新 PNG。更细眼神/朝向与说话躯干表演待第二批 Blender 候选验收 |

`companion-motion.js` 只管原生短走，`cc-life.css` 主要是页面样式；不把三态硬塞进这两个不相干的入口。新增共享决策在 `packages/protocol/src/cc-activity.js`，桌面由 `gen:routes` 原字节生成对应模块，App 直接引用；测试约束两份相同。

## 状态 → 动作合同

优先级：连接事实 → 待决/故障功能 → 真实输出 → 真实处理 → 局部输入注意 → 真实结果/内容注意 → 中性待机。动作不增加完成事实；`replied` 只表示这一轮回复，不能宣称整个委托完成。任何高优先级状态、中断、隐藏与断线都可抢占。

| 状态 / 唯一真实信号 | 动作 / 时长与曲线 | 频率上限与退场 | 减少动态替代 | 生产方式 / 批次 |
| --- | --- | --- | --- | --- |
| 主人在输入：当前焦点输入框发生内容变更；非空草稿本身不算 | listening，180ms ease-in-out 侧倾 −2°，围绕原脚底；停键 1600ms 回中 | 一段输入保持同一姿态，不按每键重播。离焦、发送、前后台变化立即停；跨桌面窗口只传布尔值并自动过期 | 原图静止；App 无障碍名称描述正在关注输入；不声称麦克风收音 | 代码，第一批 |
| CC 在处理：当前 owner `running.turnId`；桌宠原有 pet phase 亦是真实事实 | thinking，600ms 微倾 +1°、600ms 回中，接 8s 停顿，ease-in-out；桌宠已有思考帧保留 | 运行证据租约 2500ms；读失败即清。没有运行事实不演，pending/排队/请求 Promise 未完成都不算 | 静止与已有功能进度提示、无障碍描述 | 共享推导+代码/旧帧，第一批 |
| CC 流式回应：已基线后，新到且 turn 匹配的 `agent_message` 文本变化 | speaking，300ms 上移 1px、300ms 回中，ease-in-out；**表示文字回应，不是发声** | 每个新片段最多保持 900ms；重复/旧页/别的 turn 不续期；stop/失败/断线立即归静。桌面定时检查的最大收束误差100ms | 原图与真实流文本；App 可访问名称仍说明新文本在到来 | 代码，第一批；无嘴型 |
| 做完：观察到 `working/waiting` 进入 `replied/done` 的新结果；桌宠既有 `last_done_at` 只代表回合结果 | App 原 230ms 小抬起、410ms 回落；桌宠复用 done/celebrate，时长跟作者帧/onEnd；不截断或重画旧素材 | 每个成功进入沿一次，标题/摘要等一般更新时间改变不重复庆祝；首读历史、隐藏、减动、重连消费不补播；当前工作/权限优先 | 原图与结果行；保留状态词 | 复用旧代码/Blender 帧，第一批收紧成功筛选 |
| 没做成 / 停止：明确 failed/interrupted/cancelled | 立即回中；保留原功能错误与恢复入口，不庆祝 | 每个错误身份一次现有 error；条目消失不能推导成功 | 同样保留错误，不表演失落 | 原功能与代码，第一批 |
| 话题泡泡出现：当前可读 recent topics 新稳定 id | App 2°短看520ms回中；桌面复用 look/attention 动作（素材原时长） | 首份可读列表只建基线；重复轮询/排序/旧id重现不触发；最多每12s一次；忙时丢弃、不排补播 | 原列表静止，仍可正常点击 | 代码+既有look，第一批 |
| 主人回来 / 离开：真实页面焦点/可见性/前台生命周期 | 离开停计时；回来直接对齐当下；不凭返回演“欢迎回来” | 不回放离开期间结果；回来后第一份数据重新建基线；Light/Dark 不受此信号改变 | 静态即时对齐 | 复用生命周期；第一批守卫 |
| 真正恢复连接：away→here 已同步 | App 720ms ease-out 明暗淡变；桌宠原8帧材质转场；几何不变 | 一次真实边沿；首次本来在线不演重连 | 直接对齐两态 | 现有素材/代码，保留 |
| 睡一觉：真实暂停/长时间无交互下既有 life doze 的中性休息 | 沿用桌宠180s门槛、doze/wake原表演；App后台完全静止 | 不新增夜间脚本；醒来不补演任务；不把睡态当断线 | 原图静止 | 现有；跨端睡/醒素材第二批 |
| 中性待机：明确空闲而非未知在做什么 | 保留桌宠眨眼6–12s、张望25–60s、生活20–40s；App4s/2%呼吸 | 不新增一层随机循环；工作/权限/输入会抑制装饰；既有好奇心预算不改 | 静止，功能内容不丢 | 现有；不重做 |
| 录音 / TTS 音量：真实 capture/playback 与振幅，当前三态**未把文本当音频** | 未来低通振幅驱动≤1%形变；停止即回零，attack80ms/release160ms | 最大10Hz更新；无音频信号无变化；无嘴、不造lip sync | 静态录音/播放功能图标 | 代码+可选身体细动，第三批 |
| 内容情绪反应 | 只接受可解释的明确结果类型，或用户主动选择的表达 | 第一批不分类私密正文；不随机演悲伤、愤怒、兴奋 | 内容本身 | 暂不做；有真实需求再定 |

跨端共享的是 **输入事实的含义与推导规则**，不是伪造跨设备输入探测。手机打字只驱动该手机；桌面同源窗口间短暂共享本机“正在输入”布尔值。不会向 daemon 写主人草稿或全局“情绪”。

流的初次历史可能超过一页：reader 推进 cursor，直到读到空增量才允许之后的新片段触发 speaking；期间 running 可真实表现 thinking。scope 变化/读失败/恢复必须重新基线；空增量不能忘掉已见的片段 id/text。此保守策略可能略晚于实际第一句开始回应，优先避免把历史回填演成实时说话。

## 三批顺序

1. **本批：可信度与小动作。** 共享三态决策；桌面主页复用 stream、桌宠只读 stream 投影与本机输入；App screen 传已有 stream/输入；话题 id 注意；修完成筛选；减动、隐藏、断线、首读、重复/长流回归。无需新美术与依赖，不改协议路由或后台。
2. **更清楚的眼神与跨端同源素材。** 冻结 rig 衍生 listening/speaking/轻回中候选：小眼神、C姿态、固定脚底；App可按预算接少量帧，PWA接同一活动合同与生命周期。先在48/96px和双态看得清再加帧。睡/醒只有获得真实产品信号才接。
3. **真实语音与长期节律。** 音频播放/收音振幅、明确结果的极少量反应、长期常驻频率观察。先证明不打扰与可停止，再决定是否值得增素材。没有计划做关系分数、依赖机制或拟人负面情绪。

新位图全部走现有 Blender 管线：保留冻结 `.blend`、canonical与旧资产字节；512×512 RGBA，anchor `(256,470)`，safe bbox与逐对共享mask按合同；新路径、来源参数、production-candidate，不自动晋升主人美术验收。跑 `node apps/desktop/scripts/validate-cc-asset-kit.mjs`；**禁止运行 `build-cc-asset-kit.mjs`**。第一批只读校验现有包。

## 验证与交付

2026-11-10 第二批实施：冻结源衍生素材与出处在 `apps/desktop/art/cc-v1/attention/`；眨眼复用已验收帧，新增左右/抬眼/低头与一组文字回应躯干候选。旧渲染器、canonical、旧素材及冻结哈希保持不变。桌面与 App 共用 `createCCResponsePerformance`：每次真实 speaking 入沿最多 4×167ms，至少冷却 2400ms，冷却内丢弃；输入按原租约持有抬眼；话题仍冷却12秒，桌面按可见泡泡相对 x 选择左右，App 按话题所在下方低头520ms。活动/话题会取消桌宠生活动作并重启平静计时；没有新增 App 无依据的睡眠循环。

PWA 从设备身份的 owner events 只读投影接入同一共享 activity 合同和表演预算，先读到空页才允许新文本触发 speaking。首读、历史、失败、隐藏/失焦、换身份与撤销均建立新基线；已恢复草稿不算输入。设备对话页头接三态（此入口会隐藏旧主页画面），明暗仍只由原 presence 管理；减少动态保留静态 CC 与无障碍阶段说明。离线浏览器证据与 App 合成信号检查不等同于真实模型/音频联调。

新增测试钉住“没信号不演”、旧文本/不同turn/首读/重复/历史分页/读失败租约、输入焦点与过期、减动中断不补演、失败/停止不庆祝与话题基线/冷却。旧pending→thinking断言改为更严格pending→idle，并新增明确running才thinking断言，保留全部旧接收/权限/结果断言；不删测试。

主Mac仅代码验证 `bun run verify`（补入App套件）、素材validator；全量前看负载，≥8不跑全量。桌面browser与App Maestro均从可信mini lab入口拿 `~/ci/lock`，只用模拟数据/公开依赖/自有快照，不启动真实后台、模型或微信。截图/关键帧与红绿、实际UI回执放任务指定scratch目录，报告说明哪些是浏览器/原生/单测证据，不互相冒充。结束清理本任务未被active指向的mini目录与App快照。

原生动效检查复用已有 `dev-e2e` 构建门，`op=cc-motion` 只在开发/验收构建可达，页面明确标注合成信号，不调用配对、钥匙串、后台或模型。截图证明原生驱动呈现，不把该检查页的亮态冒充真实连接。
