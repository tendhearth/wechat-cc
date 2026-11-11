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

主人对照 Claude 桌面截图认为 CC 字体过大、阅读不舒服,确认缩小界面字号、中文改为无衬线,并追加「英文也对齐」及统一样式。随后实看本机 Claude 2.19675.0:界面用 Anthropic Sans,聊天字体设置为 Anthropic Serif,已有 Cowork 对话也使用英文衬线。桌面依用途分配字体,此条覆盖本 spec 的桌面全局衬线要求;原生手机字体方案保留。

- 界面英文与用户消息引用本机 Anthropic Sans;助手回复与历史阅读的英文引用本机 Anthropic Serif。normal / italic 只声明实际使用的 400–500 可变字重,延续克制的字重规则。macOS 中文使用苹方(PingFang SC);缺少本机字体时,界面回退系统无衬线,英文阅读回退已打包的 TH Serif 4,中文仍走系统 CJK 无衬线。两个角色的字体栈均从 design-tokens 生成,仓库与安装包不包含或下载 Claude 字体。
- 当前机器以 `~/Library/Fonts/CC-Claude-Anthropic{Sans,Serif}{,-Italic}.woff2` 符号链接引用已安装 Claude 2.19675.0 的 WOFF2,通过 CoreText 注册为个人字体。CSS 引用常规与斜体的 `Anthropic{Sans,Serif}Variable-TextLight{,Italic}`;实际 400 / 500 渲染实例分别为 TextRegular / TextMedium。此为本机设置,不入库;Claude 更新后若移除原资源,重新注册当前字体即可,缺失时自动回退。
- 侧栏导航 14px / 1.5;聊天与历史正文 16px / 1.6,纯文本用户气泡沿用 15px / 1.6。工作台任务正文保留适合长阅读的 1.8 行距,英文阅读字体与聊天一致。输入框、待办、设置与生活记录面板使用界面字体;用户 Markdown 也明确使用 Sans。
- 回忆、待办与觅食标题统一为 22px / 1.3 / 400,回忆标题与说明使用一致间距。正文强调用 500 字重,移除统一底色。桌面陪伴窗口与独立 QA 入口加载相同字体角色;代码与权限原文继续等宽。
- 桌面品牌字(侧栏与引导)保留 TH Serif 4;代码继续使用 Geist Mono。
- 验证使用独立工作区内的既有样式检查、Bun / Node 测试、类型与模块边界检查,并用 dry-run 演示数据核对宽、窄窗口。安装包需重新构建,共享安装与部署仍由指定整合者串行完成。

本批交接:开发负责人 Codex(当前对话);工作区 `/Users/nategu_mac_company/.codex/worktrees/cc-desktop-typography/wechat-cc`;分支 `codex/desktop-typography`;起点 `dev` 的 `c122defa17aa9c104d38274cbabcb700f6d4929d`。主人指定交付方式为推送功能分支并向 `dev` 开 PR,由主人审查、完成 CI 与真机自检后合并;Codex 不直接推送或合并 `dev`。原生 1.7.4 候选包已从 `852ba27d` 构建,未安装或部署。

验证(2026-10-04):`bun run test --maxWorkers=4` 11699 通过 / 14 跳过;`npm run test:node -- --maxWorkers=4` 10009 通过 / 18 跳过;`bun run typecheck` 通过;`bun run depcheck` 0 错误 / 21 警告;独立 dry-run 的 `design-shots.spec.ts` 宽、窄、离线 3 项通过。首次同时跑全套与出图时,两个子进程用例失败且字体资产测试触发页面热刷新;分开复测与最终全套均通过。浏览器确认导航和「生活与工具」为 14px / 21px、回复与输入框为 16px / 25.6px,中文实际字体为 PingFang SC;品牌字仍用 TH Serif 4。共享网页生成物仅多出尚未使用的无衬线变量。独立代码复核无剩余问题。

英文追加验证(同日):Bun 全套 11699 通过 / 14 跳过、Node 全套 10009 通过 / 18 跳过、类型检查通过、模块边界 0 错误 / 21 既有警告、宽 / 窄 / 离线出图 3 项通过。实际渲染为 Anthropic Sans 的 TextRegular(400)、TextMedium(500)、TextRegularItalic;混排中文仍为 PingFang SC,代码仍为 Geist Mono。模拟本机缺少该字体时,英文正确回退 SF NS,中文保持苹方。首次声明 300–800 被既有字重守卫拒绝,收窄为 400–500 后全套通过;未放宽守卫。共享网页生成物的三处差异均仅为未使用的 sans 别名,独立复核无剩余问题。

阅读与样式收口验证(同日):最终 Bun 全套 11699 通过 / 14 跳过、Node 全套 10009 通过 / 18 跳过、类型检查通过、模块边界 0 错误 / 21 既有警告。回忆、觅食、待办与对话的既有浏览器交互检查 42 项通过,包含宽窄窗口及完整阅读面板。独立渲染检查确认英文回复为 Anthropic Serif 的 TextRegular / TextMedium / TextRegularItalic,用户消息为 Anthropic Sans TextRegular,中文仍为 PingFang SC,代码为 Geist Mono;工作台任务正文使用 Serif / 16px / 1.8,历史阅读为 Serif / 16px / 1.6,用户 Markdown 为 Sans。默认未聚焦 composer 为 hair 边框,正文强调无底色;回忆标题为 22px / 1.3 / 400,伴随窗口已加载 Sans 与等宽字体依赖。模拟缺少本机 Claude 字体时英文阅读回退 TH Serif 4,中文仍为苹方。共享网页生成物的三处差异仅多出未使用的 reading 变量。独立代码与截图复核无剩余问题。首次 Bun 全套仅真实 Git 远端更新检查超时;该项单独复测 4.11s 通过,随后全套重跑通过,未改测试或超时。原生新 app 尚未构建安装,当前安装版仍为旧样式。

基线同步(同日):本地 `dev=c122defa` 与 `origin/dev=2e9a29fb` 已分叉(共同祖先 `cdd822c0`,左右独有 3 / 11 个提交)。字体分支合并远端 1.7.4 更新,保留本地已确认的文件预览/阅读功能。Rust 冲突同时保留预览 commands 与新的 macOS 显示名菜单;聊天类型同时保留阅读来源、附件和过程;伴随窗口同时保留新显示名及共享字体依赖。独立复核无剩余问题。合并源码重新通过 Bun 11773 / 跳过14、Node 10066 / 跳过18、类型检查、模块边界0错误 / 21既有警告、44项浏览器交互和字体渲染检查。候选版本为1.7.4;共享安装与部署仍待指定整合者。

PR 交付补验(同日):文件预览浏览器测试12项通过,覆盖HTML隔离与交互、PDF画布/选字/页码/缩放/原文件下载、完整网站相对资源及服务恢复;`cargo test --release html_preview` 18项通过。宽窄字体验收截图及来源记录入 `apps/desktop/art/cc-typography/`。源码验证提交为 `852ba27d`,此后仅补交付说明与截图;合并、CI和真机自检由主人负责。

## 11. 组件合同与两端统一第一批（2026-11-08 主人决定）

本节覆盖前文「全衬线」「任务状态只用点」「胶囊聊天输入」的历史要求；字体延续 §10 已批差异。本批为 A + B1 + B2，只改桌面 apps/desktop 与原生 apps/app 的外观和信息层级，不改数据、路由、迁移、授权或提交语义。图标库、动效、设置/记忆页的 B3 结构另批。

唯一组件外观合同在 `packages/design-tokens/src/index.ts` 的 `componentAppearance`：文字角色、padding、圆角、边框、主次/按下/禁用/选中态及触区。CSS由同一生成器输出变量，RN直接import；两端分别实现与验证，不建跨端渲染框架，守卫棘轮只增不减。

| 共同合同 | 桌面保留 | App保留 |
|---|---|---|
| 同一typeScale角色/层级；用户消息bubble、CC正文body、事项item、话题small；400/500 | Sans界面与中文，英文CC回复Reading，品牌Serif | 衬线及现有中英映射 |
| Button胶囊；主accent/onAccent，次透明/hair；统一按下/禁用透明度 | small、36高；次级允许28 compact，hover与键盘焦点 | body、至少48；IconButton至少44，不依赖hover |
| TextField显式variant：chat为sheet14多行，search为control28单行，comment为嵌入式底线；默认hair、焦点accent | Enter发送、Shift+Enter换行、IME保护、拖文件；行审阅目标 | 48聊天/评论、44搜索；安全区/键盘避让/原生图片与按住说话；plain留全页书写区 |
| 用户消息rail浅底、bubble14、横16/竖12；CC透明正文；不逐条加CC头像 | 去32头像与预留缩进 | 来源、时间、失败/未确认入口 |
| 话题hair/control胶囊、透明底，当前打开项ink边，selected语义与想起/收起数据分开；6项+更多 | 右栏可收起、Escape与Tab焦点管理 | ≥44触区，禁止rail选中色块；55%/全屏formSheet、grabber与返回手势 |
| 内容以留白分组；事项引用至多一层hair边，内部过程无框 | 宽屏对话+右侧话题/事项；窄屏覆盖层 | 单栏、原生推入与逐层返回；无框引用仍合法 |
| 任务词/记号/tone只认protocol status-table；waiting记号accent，其余inkSoft；细分观察词也共源 | 保留排队、后台工作与网络暂停事实 | 详情状态和步骤改用共享记号；连接/错误仍保留语义点 |
| 页头CC可点占位44、图像可适配；执行者头像在名称前；不逐条画回复头像 | 图44，可选独立浮宠 | 图36/触区44，页内原生在场表现 |
| 详情：具体请求→当前进展/真实成果；旧对话、执行信息和过程默认收起，待决与错误仍可见；旧回复不冒充新请求结果 | 审阅/回退/工作区工具次级；行选/Shift多选、宽diff、多层工程工具 | 触摸按块评论、纵向文件、受限高度预览；审阅草稿 |
| 同一对话、事项、输入目标、草稿、requestId、返回位置和已处理语义 | 本机权限、daemon和项目路径工具 | 配对、设备通知、隐私和语言工具 |

保留所有testID/选择器。任务、连接、授权结果和未确认/陈旧状态分开，不把它们强塞进六种任务态；不追求逐像素相等。

本批负责人为当前Codex；工作区 `/Users/nategu_mac_company/Documents/tendhearth/wt-design-b1-codex`，分支 `design-unify-b1`，起点 `34aa50a364e988cba4acc4f0c31096a1b52324de`（origin/dev）。只读子任务不写工作区。只提交功能分支，不合入dev、不推送、不部署。

主Mac默认 `bun run verify`，App/design-tokens变更须带App自己配置的 `bun run test`；UI只走mini lab共享锁。2026-11-08主人禁止App模拟器通道，当天不运行App Maestro或生成App前后图，不以历史图冒充。桌面用不可变源码快照与同一合成场景产前后对照；实际回执与未完成项写任务报告。

## 12. B3：设置与记忆（2026-11-10 产品负责人定）

负责人：当前 Codex；工作区 `wt-design-b3`、分支 `design-b3`，起点 `f747f7a20bf70188bc777e7324ec2bf207f8ddda`（origin/dev）。子任务只读，工作区由负责人串行写入；只提交，不推送或部署。§11 七项决定继续适用，字体差异保留，只统一字号角色。

### 审计

| 范围 | 桌面基线 | App 基线 | B3 定案 |
|---|---|---|---|
| 设置分组 | 连接 → Pro 会员 → 后台服务 → 行为 → 隐藏实验 → 项目管理 | 和 CC → 家里的电脑 → 偏好（含关于）→ 配对/演示 | 先连接和电脑，再偏好，最后管理/关于；平台独有工具保留，不补对称功能 |
| 设置行 | 380px 抽屉，13/11.5px 标签/说明，开关有框，控件密集 | 24pt 边距，无框 52/56pt 行，meta 分组，disclosure 与链接图标色不同 | B1 行几何（matterRow 的 64 最小高度、12 竖留白/间隔）；标签 body、说明 small、分组 meta；无框、长文自然增高 |
| 连接/能力四态 | 浮层“CC 现在怎么样”→ 能力（无小标题）→ 来源 → 电脑 → 最近在做 → 成果 | “连接”→ 总览 → 电脑 → CC 现在怎么样 → 来源 → 最近在做 → 成果 | 标题“CC 的连接”；总览 → 家里的电脑 → CC 现在怎么样 → 来源 → 最近在做 → 成果；点旁始终有文字 |
| 记忆结构 | 事实/查找/纠正 → 记忆库（收回的话在里面）→ 推测画像 | 记住的/待办 → 事实分区 → 收回的话 → CC 眼中的你 | 事实先；收回的话、推测画像按需展开，桌面原始记忆库最后；待办与原路由保留 |
| 记忆阅读/编辑 | 事实 body，查找框 nav8；逐行编辑输入框6，来源弹窗20/10/9等混用 | 事实 bubble15、分组caption12；事实入口没有展开提示；纠错为裸文字动作 | 事实 body、分组meta；查找 search28，编辑 chat14；入口有明确纠正/展开提示，复用 B1 按钮与焦点态 |
| 危险操作 | 断开：展开连接选项后提交；逐行删除先改草稿再保存，超过5条二次保存；项目删除3秒内二次点 | 解除配对：原生 Alert 取消/destructive；记忆：选中事实后点 verdict 提交 | 统一目标 → 后果 → 取消在前/破坏动作在后；保留全部原确认门槛、提交时机和失败反馈 |

### 统一结构与控件

- 设置：App 继续“和 CC”（记忆、信、定时的事、最近的事）→“家里的电脑”（CC 的连接、电脑会话、设备）→“偏好”（语言、通知、隐私）→“关于 CC”→配对/演示与家族署名。桌面“家里的电脑”（原有连接、账户和手机）→“偏好”（后台服务与行为的原控件）→项目管理→Pro 会员，隐藏实验保留。桌面的主导航仍是记忆入口。
- 记忆：桌面只保留标题“记忆”，移除重复的“记住的”副标题；App 保留同名页签。收回的话 → CC 眼中的你 → 桌面记忆库；事实与推测不混排，生成、重读和本机项目来源说明保留。两端横向留白按 App 的24，桌面宽阅读区保留合适行长。
- 确认：沿用各端已有承载方式。App 解除配对继续原生 Alert；记忆现有选中记录下的选择区补后果说明，取消在前、“不用记”最后，选择即提交的语义不变。桌面连接选项补停止后果和收起取消；记忆的删除仍是编辑草稿，保存/批量二次保存和脏稿切换原样保留。确认区至多一层 hair/sheet14，次级按钮透明胶囊，不靠大块危险色。
- 字号、圆角、留白、按下/禁用和焦点全部消费 `packages/design-tokens`/B1 合同。仅 B3 页面显式采用舒展的行几何，共用 Rows 的其它调用不受影响。现有 App 图标已经来自 Lucide，本批不添库、不批量换图标。详情页不新增 CC 在场条。
- 不改数据、路由、迁移、授权、状态推导、请求体或提交时机。陈旧/未知与能力四态保持原映射；App 能力动作仍是去电脑/微信处理的提示。

### 验收与证据

主 Mac 在同一命令检查一分钟负载 <8、无 CivilizationVII 后跑 `bun run verify`，不在主 Mac 跑 UI。mini 只走持有 `~/ci/lock` 的 browser 与 app-maestro 入口。今天明确允许 App 模拟器，覆盖 §11 的11-08当日限制。

桌面 baseline 为上述起点，前后使用同一白名单截图 harness；App 为保留严格的 verified-after 接收边界，先提交只含截图/入口的基线，再提交产品实现，同一 Maestro YAML 拍前后。截图、并排图、命令/源码摘要和实际结果见任务外 `scratchpad/design-b3-shots/README.md`；未完成与红/绿写 `scratchpad/codex-design-b3-report.md`。取回证据后持共享锁清理本任务创建且未被 active.json 引用的快照，不清理其它任务或公共缓存。


### 截图后收口（2026-11-10）

三页内折叠行统一为左侧 label + 行最右单一 ›；展开旋转90°，整行可点，沿用 B1 matterRow 几何。原生 details 与脚本按钮保留原行为/ID，内层资料、全文、依据原文和连接确认详情也用同一结构；不改对话页的「N 件事等你」。桌面「当前连接中的用户」采用与「家里的电脑 / 偏好 / 项目管理」相同的 meta 分组标签样式，保持账户紧邻连接动作，避免大标题抢占层级。

记忆事实下不再展示工程文件名。App 的 Last tidied 来自每晚整理的 when_label；没有同源整理时间时隐藏整行，不以文件 mtime 或项目地图生成时间替代。
