# Tendhearth 设计统一(桌面 + 手机)· spec 增补(plan 6)

日期:2026-10-01。状态:设计稿。基线 origin/dev 474354f7(#162 手机 app 跟 CC 说话)。增补 `2026-09-30-tendhearth-app-v1-design.md` 与 `2026-10-01-tendhearth-app-chat-design.md`;桌面侧推翻 `2026-09-26-web-design-unify` 之前「Clean Light / Geist」那套风格。

依据(主人 2026-10-01 拍板,**有约束力**):
- `~/Documents/tendhearth/cc-screens-2026-09-30/CC-设计原则.md`(下称「原则」)
- 认可稿 `~/Documents/tendhearth/cc-screens-2026-09-30/desktop-redesign-now.html`(桌面「此刻」;窄屏即手机版,下称「稿」)
- 背景 `CC-说明.md`;两端现状截图 `desktop/`、`phone/`、`cc-character/`

## 0. 白话

两个 app 长成一家人:同一张暖纸、同一套衬线字、一个深绿强调色、CC 是唯一的插画。每屏只回答「现在有什么要我管的?」。页面永远不变色;只有 CC 变 —— 电脑在、CC 醒着就是发光的 Light CC,不在就是安静的 Dark CC,而且明暗来自真实信号。

## 1. 主人的决定(逐条照抄成规矩)

1. 屏上只留 CC 形象和功能;同一信息只出现一次;没有客套话;只放能用的按钮(没上线的语音 / 附件不出现)。
2. 一套衬线体到底:中文 Noto Serif SC,西文 / 数字 Source Serif 4。**两个 app 都本地打包字体,运行时不走 CDN**(桌面 Tauri、Expo 都是)。授权 SIL OFL 1.1,随字体放 `OFL.txt`。
3. 层级靠字号与留白,不靠粗细:只用 400(常规)与 500(中等);不用 600 及以上。
4. 一个强调色(深绿,只给动作)+ 灰阶 + 暖白底。状态色只用在状态点上(绿 在线 / 正常、琥珀 落后、红 没连上、灰 不知道);**不默认绿**。
5. 不套卡片(最多一层)、不要图标圆圈、彩色块、渐变按钮、阴影堆叠;装饰只剩 CC 的光、极淡纸感、细分隔线。
6. 没有「稍后处理」;事项行整行可点,点进去才是批准页;行上最多一个动作。
7. CC 是唯一插画;气泡显示 **CC 最近说的一句真话**,点气泡或 CC 就进对话(取代「接着聊」)。
8. **没有深色模式**:两个 app 永远同一张暖纸,不跟系统变。
9. **CC Light = 在身边,CC Dark = 不在身边**,只来自真实信号(§4)。
10. 手机底部标签只留「此刻 / 一起做」,设置收进头像;桌面侧栏只放导航,不放标语。

## 2. 设计 token(唯一出处)

唯一出处是新包 `packages/design-tokens/src/index.ts`(纯 TS,无依赖)。手机 app 直接 import;桌面是静态文件、不能 import TS,所以由 `scripts/build-design-tokens.ts` 生成 `apps/desktop/src/tokens.css`,守卫测试 `scripts/design-tokens.guard.test.ts` 钉住「生成物 == 现在渲染的结果」。

### 2.1 颜色

| token | 值 | 用途 |
|---|---|---|
| `ground` | `#efeae2` | 桌面窗口背后的桌面 / 窄屏外沿;手机不用 |
| `paper` | `#faf7f2` | 页面(两端唯一底色) |
| `rail` | `#f3eee6` | 桌面侧栏;手机底部标签栏 |
| `ink` | `#2a2622` | 正文 |
| `inkSoft` | `#70665d` | 次要文字(稿里 `#7a7067` 在 `rail` 上只有 4.19:1,调深到 4.85:1 过 AA) |
| `hair` | `#e4ddd2` | 细线、气泡 / 输入框描边 |
| `accent` | `#4f6b4f` | 唯一强调色:主动作、焦点、悬停 |
| `onAccent` | `#fbfaf6` | 强调色上的字 |
| `ok` | `#5f8a5a` | 状态点:在线 / 正常 |
| `warn` | `#b07a2a` | 状态点:落后 |
| `bad` | `#b5533c` | 状态点:没连上;以及错误文字(4.61:1) |
| `unknown` | `#70665d` | 状态点:不知道(= inkSoft,绝不是绿) |
| `glow` | `rgba(255,214,150,0.55)` | 只给 Light CC 身后的光 |
| `scrim` | `rgba(42,38,34,0.36)` | 底部弹层遮罩 |

对比度(守卫测试里算):`ink`/`inkSoft` 在 `paper`、`rail`、`ground` 上 ≥ 4.5;`onAccent` 在 `accent` 上 ≥ 4.5;`accent`、`bad` 在 `paper` 上 ≥ 4.5;四个状态点在 `paper` 上 ≥ 3(非文字)。

### 2.2 字

- 家族:`serifLatin = TH Serif 4`(Source Serif 4 的拉丁子集;OFL 保留字体名 "Source",被修改版不得沿用,所以家族名、文件名一律 TH Serif 4 / `THSerif4-*` / `th-serif-4-*`)、`serifCJK = Noto Serif SC`、`mono = Geist Mono`(**只给代码、路径、diff、日志**;不再用于时间、标签)。
- 字重:`regular 400`、`medium 500`。别的都不许。
- 字号(px)与行高:

| role | 桌面 | 手机 | 行高 | 字重 | 用在 |
|---|---|---|---|---|---|
| `display` | 48 | 36 | 1.15 | 400 | 问候「晚上好」 |
| `wordmark` | 24 | 20 | 1.2 | 500 | `tendhearth` / 页标题 |
| `title` | 22 | 20 | 1.3 | 500 | 详情页标题 |
| `item` | 18 | 17 | 1.4 | 400 | 事项行标题 |
| `body` | 16 | 16 | 1.6 | 400 | 正文、输入框、导航 |
| `bubble` | 15 | 15 | 1.6 | 400 | CC 气泡 |
| `meta` | 14 | 14 | 1.5 | 400 | 行下一句说明、小节标题(`inkSoft`,字距 .04em) |
| `small` | 13 | 13 | 1.5 | 400 | 顶部状态行、时间 |
| `caption` | 12 | 12 | 1.4 | 400 | 气泡里的时间 |

### 2.3 形状与留白

`radius = { nav: 8, bubble: 14, sheet: 14, control: 28 }`(气泡右下角 4);`space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 36 }`。没有卡片阴影;桌面窗口不画外框阴影(Tauri 窗口本身就是窗)。

## 3. 字体打包

- 来源:google/fonts 仓库 `ofl/notoserifsc/NotoSerifSC[wght].ttf` 与 `ofl/sourceserif4/SourceSerif4[opsz,wght].ttf`(都带 `OFL.txt`)。脚本 `scripts/fonts/build-fonts.sh` 用 fonttools(`varLib.instancer` 切出 400 / 500 静态字重,Source Serif 4 的 opsz 钉在 16;`pyftsubset` 按下面的范围裁剪),**生成物入库**,运行时不下载。脚本只在维护者要换字体时跑,来源的 sha256 写进 `scripts/fonts/sources.lock.json`。
- 范围:Noto Serif SC 保留 Basic Latin、Latin-1、常用标点(U+2000–206F)、CJK 符号与标点(U+3000–303F)、全角(U+FF00–FFEF)、CJK 统一表意文字基本区(U+4E00–9FFF);扩展区的字退回系统字体(主人聊天里极少见)。Source Serif 4 保留 Latin 子集。
- 手机:`apps/app/assets/fonts/` 下 4 个 TTF(`NotoSerifSC-Regular/Medium`、`SourceSerif4-Regular/Medium`)+ `OFL.txt`,用 `expo-font` 的 `useFonts` 在根布局加载;加载失败也不挡页面(退回系统衬线)。
- 桌面:`apps/desktop/src/fonts/` 下 4 个 woff2 + `OFL.txt`,`@font-face` 用 `unicode-range` 把西文交给 Source Serif 4、中文交给 Noto Serif SC。删掉 Geist(无衬线);Geist Mono 留给代码。CSP 本来就是 `font-src 'self'`。
- 体积预算(守卫测试):手机字体合计 ≤ 30 MB,桌面字体合计 ≤ 20 MB。超了 ⇒ 先砍 CJK Medium(层级本来就靠字号),仍超则停下问主人。
- 手机上 RN 一个 `Text` 只能指定一个字体家族,缺字会退回系统**无衬线**。所以手机按「这段字是什么」选家族:界面文案按语言(`zh-Hans` ⇒ Noto Serif SC,`en` ⇒ Source Serif 4);用户内容(聊天、事项标题、命令说明)一律 Noto Serif SC(它的西文字形本来就出自 Source Serif 一脉)。字重靠换家族名(`…-Medium`),**永不设 `fontWeight`**(安卓上自定义字体设 fontWeight 会退回系统字)。

## 4. CC 的明暗(真实信号)

一个事实,两端各一个纯函数:

- **手机** `ccPresence(conn)`:`conn.state === 'online'`(手机与家里电脑的隧道握手成功、daemon 在答话)⇒ `here`;`connecting` / `offline` / `revoked` ⇒ `away`。
- **桌面** `ccPresence(presence)`:`/v1/companion/presence` 轮询拿到真数据(`presence !== 'down'`)⇒ `here`;拉不到(daemon 没跑 / 卡死,poller 发 `DOWN_PRESENCE`)⇒ `away`。

为什么只看「够不够得着」:「电脑离线」与「CC 睡了」落到信号上都是 daemon 答不上话(电脑合盖 / 关机 / 断网 ⇒ 手机隧道断;daemon 没跑 ⇒ 桌面轮询失败)。`presence.presence === 'offline'` 指的是**微信外发**不通,CC 本人还在电脑上答话,所以 app 里不变暗(状态点另外报)。伙伴静音(snooze)只是不主动找你,CC 照样答话,也不变暗。

不在身边时:CC 换 Dark 图、身后的光消失、呼吸停;状态行写「家里的电脑 · 不在线 · 20:34 同步」(手机用 `lastSyncedAt`;桌面是电脑本身,写「CC 没在运行」)。状态点照原则 §4:在线 = 绿,离线 / 已撤销 / 桌面 daemon 没跑 = 红(没连上),正在连接 = 灰(不知道)。稿里离线画的是灰点 —— 原则的文字更明确,按原则来,交主人确认(§9)。图都已在库(`apps/app/assets/cc/{lit,unlit}.png`、`apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png`,与稿用的 `cc-light.png` 同一张),**不需要新美术**。

不在本计划:桌面浮窗桌宠(`companion-window` / `pet/bridge/presence-map.js`)现在只在「在聊」时点亮;它跟 app 页的规则对不对齐,交主人定(§9)。

## 5. 手机

### 5.1 全局
- 删掉深色:`palette` 只剩一套;`useTheme()` 返回固定色板(不再读 `useColorScheme`);`app.json` `userInterfaceStyle: "light"`、去掉 splash 的 `dark`、splash 底色改 `paper`;`StatusBar` 永远 `dark`。
- 新 `Txt` 组件(`src/ui/Txt.tsx`)与 `TextField`(包 `TextInput`):按 `role` 取字号 / 行高 / 家族;页面不再直接用 RN 的 `Text` / `TextInput`。
- 组件:`Button`(主 = accent 实底 onAccent 字,次 = 无底 hair 描边;都是 400 字)、`Card`(一层:paper 底 + hair 描边,无阴影,禁止嵌套)、`StatusPill` → 只剩「点 + 文字」(不再有 accentSoft 底块)、`TabBar`(rail 底、选中只把字变 ink、不加色块)、`TopBar`、`SayBar`、`Sheet`、`DemoBanner`、`PushBanner`、`ConnectionNotice`、`Placeholder` 全部换 token。

### 5.2 此刻(照稿重排)
从上到下:
1. 顶栏:左 `tendhearth`(wordmark);右 状态行「● 家里的电脑 · 在线」+ 头像(进设置)。**状态行就是「CC 的连接」入口**(点它进 `/connections`),原来正文里那一行「CC 的连接 …」删掉。
2. 演示横幅(只在演示模式)。
3. 问候 `display`「晚上好」(按钟点三档)。删掉「周三,慢慢来」日期行与「现在没有需要你决定的事」之类概括句。
4. CC:右对齐的气泡 + CC 形象(120pt)。气泡 = 主人对话里**最近一条 CC 发的消息**(`chat:latest` 查询,与 `/chat` 同一份缓存),正文最多 3 行、下面一行小字时间;点气泡或 CC ⇒ `/chat`。没有 CC 说过的话(还没设主人 / 读失败)⇒ 不画气泡,只有 CC,点 CC 照样进 `/chat`。删掉「我在,事情也在。」「我正在忙…」两行。
5. 「N 件事等你」(`meta` 小节标题,N=0 时整节不出现):每行 = 标题(批准 / 问题的说明标题,没有就用原始概括)+ 一行说明(所属事项标题)+ 右侧「看清楚 ›」(权限)/「回答 ›」(问题);整行可点 ⇒ `/approval/<taskId>`。行之间细线,没有卡片。
6. 删掉「一起做的事」列表(它在「一起做」标签里,不重复)。
7. 底部固定「跟 CC 说一句…」(圆角 28 的描边条,右端 accent 圆钮 ➤;整条是一个按钮 ⇒ `/chat` 并聚焦输入框)。

离线提示:状态行已经写「不在线 · 20:34 同步」,所以 `ConnectionNotice` 在此刻页只保留「已撤销」那一种(它带「重新配对」动作);其他页照旧。

### 5.3 其他页(只换皮,不改结构)
一起做、对话 `/chat`、事项进展、批准 / 问题卡、交办、CC 的连接、电脑上的会话(列表 + 详情)、设置、设备、配对、欢迎、推送打开页、开发用推送密钥页:全部换 token 与 `Txt`;标题 `wordmark`/`title`,不加粗;去掉卡套卡;状态只用点。**交办页删掉「加一张图」按钮和「暂不支持」提示**(功能没上线)。

### 5.4 testID 与 Maestro
所有现有 testID 保留。结构有变的地方:
- `now-connections` 从正文行移到顶栏状态行(同一个 testID,`topbar-connection` 留在里面那段文字上)。
- `now-needs-you-card` 落在每一行的外层 View;`now-look-then-decide` 落在整行的 `Pressable` 上。
- `now-together-item-*` 随列表删除(Maestro 没用到)。
- 新增 `now-cc`(CC 形象按钮)、`now-cc-bubble`(气泡)、`now-waiting-title`(小节标题)。
- `compose-add-image` / `compose-image-note` 随功能删除;改 `compose.yaml`。
- 新 Maestro 流 `.maestro/design-shots.yaml`(演示模式,`takeScreenshot` 出图);不进 CI,由执行者手动跑。

## 6. 桌面

### 6.1 全局
- `index.html` 先引 `tokens.css`;`styles.css` 的 `:root` 旧变量全部改成指向 token 的别名(`--paper: var(--th-paper)`、`--green: var(--th-accent)`、`--green-soft: transparent` …),于是所有用变量的地方一次换皮。字体变量:`--sans` 与 `--cjk` 都指向衬线栈,`--mono` 只给代码。
- 字重:CSS 里 `font-weight` 只许 400 / 500 / `normal`(`b, strong` 统一 500)。
- 硬编码颜色:「此刻」「一起做」「跟 CC 说」三块的样式表里不许再有字面色值(全用 token);其余样式表按旧色板 → token 映射表机械替换,剩下的数目由守卫测试棘轮钉住、只许减不许增。
- 不加深色模式(本来就没有);守卫测试钉住任何样式表都不出现 `prefers-color-scheme: dark`。

### 6.2 侧栏
从上到下:`tendhearth` wordmark → 导航「此刻 / 一起做 / 回忆」→ 折叠的「更多」(画室、记忆、待办、觅食、后厨;纯文字链接)→ 底部「设置」(`#settings-open`)。删掉:CC 图标锁定字、「一起生活,也一起做事」标语、版本号(原计划搬进设置抽屉的「关于」;实施时整行去掉——那是写死的、而且是错的,没有可靠来源,宁缺不错)、导航图标、侧栏底部的状态点与时钟(搬到主区右上)、「跟 CC 说」入口(CC 气泡就是入口)。所有 `data-pane` 按钮与 `#settings-open`、`.cc-life-nav-more` 保留(e2e 依赖)。

### 6.3 此刻(照稿)
`article.cc-now-pane` 有两个状态 `data-now="home" | "chat"`:

- **home**(默认):右上状态行(= `.cc-home-details > summary`,含 `#dash-rail-dot`、`#dash-rail-text`,文字如「CC 在家 · 运行中」),点它展开连接面板(原「鱼缸与连接」整块内容,改为浮在右上的单层面板,`Esc` / 点外面收起);问候 `display`;右侧 CC 气泡(主人对话里最近一条 CC 的话 + 时间)与 CC 形象(150px,Light 带光 / Dark 无光);「N 件事等你」行列表(数据:`/v1/workbench/attention`,每行 = 任务标题 + 一行「1 项权限 · 1 个问题」+「看清楚 ›」/「回答 ›」,整行 ⇒ 打开工作台该任务);底部 composer = 现有 `#converse-input` + `#converse-send`(home 状态只露这两样)。
- **chat**:点气泡 / CC、在 composer 里发出一句、或导航到 `converse` ⇒ 切到 chat:顶部一行「‹ 此刻」返回、对话记录(`#converse-scroll`)占满、composer 的完整工具条(语音输入、朗读回复、交给 CC 做)出现。语音输入在桌面是已上线功能(Tauri `agent_transcribe`),所以留。
- 此刻页可见时,全局的 `#workbench-attention` 横条隐藏(同一件事不出现两次);离开此刻照旧。
- 「CC 正在照看的事」入口(care sheet)从此刻页撤下:它与「N 件事等你」和「一起做」重复。模块与测试保留,入口去掉。

### 6.4 其余面板
一起做(工作台)与跟 CC 说先做:零字面色值、衬线、无粗体、状态只用点(任务状态签改「点 + 文字」)。回忆、画室、记忆、待办、觅食、后厨、设置抽屉、引导向导:只做 token / 字体 / 字重这一遍,结构不动。

### 6.5 e2e
保持 desktop-e2e 全绿(合前本地 `bun x playwright test`,4176 端口)。只在结构变了的地方改 spec:`button[data-pane="converse"]` 不再在侧栏(改为断言气泡是入口)、此刻 home/chat 两态、侧栏版本号位置。导航一律走 `clickNav` / `reveal`。新加 `playwright/design-shots.spec.ts`:只有设了 `WECHAT_CC_DESIGN_SHOTS=<目录>` 才跑,出 1440×900 与 760 宽两组图(此刻 here / away、一起做、跟 CC 说、回忆、设置)。

## 7. 视觉验收

- 手机:`maestro test .maestro/design-shots.yaml --test-output-dir …`,中英各一遍。
- 桌面:`WECHAT_CC_DESIGN_SHOTS=… bun x playwright test design-shots`。
- 图放 `~/Documents/tendhearth/cc-screens-2026-10-01-design/{desktop,phone}/`(仓库外),旁边放稿的截图;执行者逐张对着稿看一遍并写 `README.md` 列出每张图与跟稿的差异。

## 8. 不做

- 手机网页 `/m`(`apps/mobile`,有自己的 `tokens.css`)与 `/set`:本计划不动,留下一份。
- 桌面浮窗桌宠、动画实验室、pet-lab 的样式。
- 新功能:不加任何新接口;CC 气泡用的是已有的对话读取。
- 退休鱼缸画布:它还在连接面板里(e2e 依赖 `#companion-stage` 可见),去留交主人。

## 9. 交主人定(不挡执行)

1. `inkSoft` 从稿的 `#7a7067` 调深到 `#70665d`(为了侧栏上的字过 AA)。
2. 桌面浮窗桌宠要不要也改成「够得着 = Light」(现在只在「在聊」时亮)。
3. 连接面板里的鱼缸画布(「进入这一刻」「浮到桌面」的舞台)去留。
4. 桌面「N 件事等你」的行标题用任务标题(attention 接口只给计数);要像手机那样显示「可以安装图片处理组件吗?」得再读一次任务详情 —— 要不要。
5. 安装包体积:字体约 +20–30 MB(手机)/ +10–20 MB(桌面),以实测为准。
6. 离线状态点:稿画灰点,原则写「红 = 没连上」;计划按原则用红,连接中才是灰。
