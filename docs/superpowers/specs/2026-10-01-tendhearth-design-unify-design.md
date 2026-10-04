# Tendhearth 设计统一(桌面 + 手机)· spec 增补(plan 6)

日期:2026-10-01。状态:已实施(#163);§9 六条主人已拍板。基线 origin/dev 474354f7(#162 手机 app 跟 CC 说话)。增补 `2026-09-30-tendhearth-app-v1-design.md` 与 `2026-10-01-tendhearth-app-chat-design.md`;桌面侧推翻 `2026-09-26-web-design-unify` 之前「Clean Light / Geist」那套风格。

依据(主人 2026-10-01 拍板,**有约束力**):
- `~/Documents/tendhearth/cc-screens-2026-09-30/CC-设计原则.md`(下称「原则」)
- 认可稿 `~/Documents/tendhearth/cc-screens-2026-09-30/desktop-redesign-now.html`(桌面「此刻」;窄屏即手机版,下称「稿」)
- 背景 `CC-说明.md`;两端现状截图 `desktop/`、`phone/`、`cc-character/`

## 0. 白话

两个 app 长成一家人:同一张暖纸、同一套衬线字、一个深绿强调色、CC 是唯一的插画。每屏只回答「现在有什么要我管的?」。页面永远不变色;只有 CC 变 —— 电脑在、CC 醒着就是发光的 Light CC,不在就是安静的 Dark CC,而且明暗来自真实信号。

## 1. 主人的决定(逐条照抄成规矩)

1. 屏上只留 CC 形象和功能;同一信息只出现一次;没有客套话;只放能用的按钮(没上线的语音 / 附件不出现)。
2. 一套衬线体到底:中文 Noto Serif SC,西文 / 数字 Source Serif 4 的子集(因 OFL 保留字体名,打包后改名 TH Serif 4)。**两个 app 都本地打包字体,运行时不走 CDN**(桌面 Tauri、Expo 都是)。授权 SIL OFL 1.1,随字体放 `OFL.txt`。
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
| `inkSoft` | `#70665d` | 次要文字(稿里 `#7a7067` 在 `rail` 上只有 4.19:1,调深到 4.85:1 过 AA;主人 2026-10-01 已拍板,§9-1) |
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
- 范围(2026-10-01 主人拍板收窄,§9-5):Noto Serif SC 保留 Basic Latin、Latin-1、常用标点(U+2000–206F)、箭头、CJK 符号与标点(U+3000–303F)、全角(U+FF00–FFEF),汉字只留 **GB2312 ∪《通用规范汉字表》一级 + 二级**(`scripts/fonts/cjk-common-chars.py` 生成:GB2312 用 Python 自带编解码器枚举,通用规范字表入库为 `scripts/fonts/tgscc-level-1-2.txt`,来源提交与 sha256 在 `sources.lock.json`;共 7635 个码位,汉字 6953)。子集外的字(生僻字、繁体、扩展区)不在包里:桌面 `--th-font-serif` 逐字退回系统衬线(Songti SC / STSong / Noto Serif CJK SC / Source Han Serif SC / SimSun);手机 RN 由系统逐字退回系统中文字体(iOS / Android 没有可指定的系统中文衬线,所以那几个字会是系统字形,但不会是豆腐块)。Source Serif 4 保留 Latin 子集。
- 重新生成:`python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli`,然后 `PYTHON=/tmp/fontenv/bin/python scripts/fonts/build-fonts.sh`(脚本头部有同样的说明;`SOURCE_DATE_EPOCH` 钉住时间戳,同版本工具两次输出逐字节相同,已验证)。结束时打印每个文件的字节数;再跑 `bun --bun vitest run scripts/design-tokens.guard.test.ts`。
- 实测(fonttools 4.60.2):手机 `NotoSerifSC-Regular.ttf` 10,550,096 → 3,573,568 字节;桌面 `noto-serif-sc-400.woff2` 4,258,508 → 1,486,280 字节。两端字体合计:手机 10,760,980 → 3,784,452,桌面 4,325,876 → 1,553,656(Latin 两款不变,只是时间戳钉住后重出)。
- 手机:`apps/app/assets/fonts/` 下 4 个 TTF(`NotoSerifSC-Regular/Medium`、`THSerif4-Regular/Medium`)+ `OFL.txt`,用 `expo-font` 的 `useFonts` 在根布局加载;加载失败也不挡页面(退回系统衬线)。
- 桌面:`apps/desktop/src/fonts/` 下 4 个 woff2 + `OFL.txt`,`@font-face` 用 `unicode-range` 把西文交给 TH Serif 4、中文交给 Noto Serif SC。删掉 Geist(无衬线);Geist Mono 留给代码。CSP 本来就是 `font-src 'self'`。
- 体积预算(守卫测试):子集化后收紧为手机字体合计 ≤ 4.5 MB、桌面 ≤ 2 MB(原 30 / 20 MB);守卫还钉住字表 sha256、子集覆盖全部 6500 个通用规范字、生僻 / 繁体字确实不在包里。
- 手机上 RN 一个 `Text` 只能指定一个字体家族,缺字会退回系统**无衬线**。所以手机按「这段字是什么」选家族:界面文案按语言(`zh-Hans` ⇒ Noto Serif SC,`en` ⇒ TH Serif 4);用户内容(聊天、事项标题、命令说明)一律 Noto Serif SC(它的西文字形本来就出自 Source Serif 一脉)。字重靠换家族名(`…-Medium`),**永不设 `fontWeight`**(安卓上自定义字体设 fontWeight 会退回系统字)。

## 4. CC 的明暗(真实信号)

一个事实,两端各一个纯函数:

- **手机** `ccPresence(conn)`:`conn.state === 'online'`(手机与家里电脑的隧道握手成功、daemon 在答话)⇒ `here`;`connecting` / `offline` / `revoked` ⇒ `away`。
- **桌面** `ccPresence(presence)`:`/v1/companion/presence` 轮询拿到真数据(`presence !== 'down'`)⇒ `here`;拉不到(daemon 没跑 / 卡死,poller 发 `DOWN_PRESENCE`)⇒ `away`。

为什么只看「够不够得着」:「电脑离线」与「CC 睡了」落到信号上都是 daemon 答不上话(电脑合盖 / 关机 / 断网 ⇒ 手机隧道断;daemon 没跑 ⇒ 桌面轮询失败)。`presence.presence === 'offline'` 指的是**微信外发**不通,CC 本人还在电脑上答话,所以 app 里不变暗(状态点另外报)。伙伴静音(snooze)只是不主动找你,CC 照样答话,也不变暗。

不在身边时:CC 换 Dark 图、身后的光消失、呼吸停;状态行写「家里的电脑 · 不在线 · 20:34 同步」(手机用 `lastSyncedAt`;桌面是电脑本身,写「CC 没在运行」)。状态点照原则 §4:在线 = 绿,离线 / 已撤销 / 桌面 daemon 没跑 = 红(没连上),正在连接 = 灰(不知道)。稿里离线画的是灰点 —— 原则的文字更明确,按原则来;主人 2026-10-01 已拍板(§9-6):离线一律红,灰只给「正在连接…」。图都已在库(`apps/app/assets/cc/{lit,unlit}.png`、`apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png`,与稿用的 `cc-light.png` 同一张),**不需要新美术**。

桌面浮窗桌宠(`companion-window` / `pet/bridge/presence-map.js`)同一条规则(主人 2026-10-01 拍板,§9-2):复用 `ccPresence`,presence 拉得到(含 `offline`,那只是微信外发不通,挂感叹号)就 Light,拉不到才 Dark;不再只在「在聊」时亮,「20 分钟没联系就退潮」删掉。联系时间只剩两个用处:前进时播一次 receive、决定 pet 端点轮询快慢档。

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

- **home**(默认):右上状态行(= `.cc-home-details > summary`,含 `#dash-rail-dot`、`#dash-rail-text`,文字如「CC 在家 · 运行中」),点它展开连接面板(「CC 的连接」+ 底部「浮到桌面」按钮,浮在右上的单层面板,`Esc` / 点外面收起;鱼缸画布已退休,§9-3);问候 `display`;右侧 CC 气泡(主人对话里最近一条 CC 的话 + 时间)与 CC 形象(150px,Light 带光 / Dark 无光);「N 件事等你」行列表(数据:`/v1/workbench/attention`;主人 2026-10-01 拍板(§9-4)后每行像手机一样 = 第一件待决的原文(接口的 `first`,权限优先,「工具: 说明」/ 第一问)+ 一行任务标题(多于一项补「共 N 项」)+「看清楚 ›」/「回答 ›」;旧 daemon 没有 `first` 时退回任务标题 + 计数;整行 ⇒ 打开工作台该任务);底部 composer = 现有 `#converse-input` + `#converse-send`(home 状态只露这两样)。
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
- 新功能:不加任何新接口;CC 气泡用的是已有的对话读取。(§9-4 拍板后例外一处:attention 每条多一个有上限的 `first` 字段,不是新接口。)
- ~~退休鱼缸画布~~:主人 2026-10-01 拍板退休(§9-3),已做。

## 9. 主人的决定(2026-10-01 已拍板,原「交主人定」六条)

1. **`inkSoft` = `#70665d`**(从稿的 `#7a7067` 调深,侧栏上的字过 AA)。`packages/design-tokens` 与生成的 `apps/desktop/src/tokens.css` 里都是这个值,仓库里不再有 `#7a7067`。
2. **桌面浮窗桌宠也是「够得着 = Light」**,与此刻页、手机同一个信号(见 §4 末段)。实现:`pet/bridge/presence-map.js` 用 `ccPresence`;`runtime-events.js` 的明暗只随 presence。
3. **鱼缸画布退休。** 「生活与工具 › 鱼缸」整页、`#companion-stage` 画布、「进入这一刻」沉浸模式、离线鱼缸插画、主窗口里挂的 `animation-lab.js`、`companion-presence.js` / `companion-scene-state.js` 与对应样式全部删掉;动画实验室(`animation-lab.html`,独立调试页)保留。浮窗桌宠原本只有「浮到桌面」一个入口,改成此刻页右上连接面板底部的普通按钮(`#companion-desktop-start`)。原来写在鱼缸页上的连接结论(`#hero-card`:重连失败、权限不足等)搬到设置抽屉「连接」段顶上,connected 时说「微信已连接」,不再轮换「看鱼」文案。
4. **「N 件事等你」行写问题 / 权限本身。** `GET /v1/workbench/attention` 每个任务多 `first: {kind:'permission'|'question', text} | null`(权限优先、最早一件;写法与手机 approvals 话题一致;压成一行、上限 120 字),还是一次轮询,不逐行再读详情。
5. **安装包体积:字体子集化。** 两端的 CJK 衬线字只保留常用字(《通用规范汉字表》一级 + 二级 + GB2312,外加拉丁 / 标点 / 全角),子集外的字退回系统衬线;脚本与前后字节数见字体子集化那份 PR 与 §3。
6. **离线状态点 = 红,灰只给「正在连接…」**(以及「不知道」:读不到 / 陈旧 / 演示)。代码核对:桌面 `nowStatusLine`(没拉到第一拍 = 灰,daemon 没跑 / 够不着 = 红)、手机 `statusLine`(connecting / 握手未同步 = 灰,offline / revoked = 红)、两端连接页电脑离线 = 红,均有测试钉住。

## 10. 桌面字体修订(2026-10-04 主人确认)

主人对照 Claude 桌面截图认为 CC 字体过大、阅读不舒服,确认将桌面界面与聊天改为无衬线,并追加「英文也对齐」。此条覆盖本 spec 的桌面全局衬线要求;原生手机字体方案保留。

- 英文优先引用本机已安装的 Anthropic Sans,normal / italic 只声明界面使用的 400–500 可变字重,延续克制的字重规则。macOS 中文使用苹方(PingFang SC);缺少 Anthropic Sans 的设备继续使用本地系统与 CJK 无衬线回退。字体栈仍从 design-tokens 生成,仓库与安装包不包含或下载 Claude 的字体。
- 当前机器以 `~/Library/Fonts/CC-Claude-AnthropicSans{,-Italic}.woff2` 符号链接引用已安装 Claude 2.16120.0 的界面 WOFF2,通过 CoreText 注册为个人字体;常规与斜体的 PostScript 名分别为 `AnthropicSansVariable-TextLight`、`AnthropicSansVariable-TextLightItalic`。此为本机设置,不入库;Claude 更新后若移除原资源,重新注册当前字体即可,缺失时界面自动回退。
- 侧栏导航 14px / 1.5;聊天正文 16px / 1.6,用户气泡沿用 15px / 1.6。输入框、待办、设置与阅读面板统一使用界面字体。
- 桌面品牌字(侧栏与引导)保留 TH Serif 4;代码继续使用 Geist Mono。
- 验证使用独立工作区内的既有样式检查、Bun / Node 测试、类型与模块边界检查,并用 dry-run 演示数据核对宽、窄窗口。安装包需重新构建,共享安装与部署仍由指定整合者串行完成。

本批交接:开发负责人 Codex(当前对话);工作区 `/Users/nategu_mac_company/.codex/worktrees/cc-desktop-typography/wechat-cc`;分支 `codex/desktop-typography`;起点 `dev` 的 `c122defa17aa9c104d38274cbabcb700f6d4929d`。整合者待指定;未合入、未安装、未部署或推送 `dev`。

验证(2026-10-04):`bun run test --maxWorkers=4` 11699 通过 / 14 跳过;`npm run test:node -- --maxWorkers=4` 10009 通过 / 18 跳过;`bun run typecheck` 通过;`bun run depcheck` 0 错误 / 21 警告;独立 dry-run 的 `design-shots.spec.ts` 宽、窄、离线 3 项通过。首次同时跑全套与出图时,两个子进程用例失败且字体资产测试触发页面热刷新;分开复测与最终全套均通过。浏览器确认导航和「生活与工具」为 14px / 21px、回复与输入框为 16px / 25.6px,中文实际字体为 PingFang SC;品牌字仍用 TH Serif 4。共享网页生成物仅多出尚未使用的无衬线变量。独立代码复核无剩余问题。

英文追加验证(同日):Bun 全套 11699 通过 / 14 跳过、Node 全套 10009 通过 / 18 跳过、类型检查通过、模块边界 0 错误 / 21 既有警告、宽 / 窄 / 离线出图 3 项通过。实际渲染为 Anthropic Sans 的 TextRegular(400)、TextMedium(500)、TextRegularItalic;混排中文仍为 PingFang SC,代码仍为 Geist Mono。模拟本机缺少该字体时,英文正确回退 SF NS,中文保持苹方。首次声明 300–800 被既有字重守卫拒绝,收窄为 400–500 后全套通过;未放宽守卫。共享网页生成物的三处差异均仅为未使用的 sans 别名,独立复核无剩余问题。
