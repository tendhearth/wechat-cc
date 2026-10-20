# 读日历和提醒(只读)—— 设计

> 2026-10-20 · 状态:**定稿,可以开工**。对标任务 #8(Gemini / ChatGPT Pulse 读日历做早报;roadmap「对标三类产品挖出的任务」)。主人 10-20「1 ok」:同意做,接受一次 macOS 授权框。

## 为什么

早报现在只有 CC 自己知道的事(终端、一起做、提醒、待办)。主人一天里最重要的安排在日历里;Apple「提醒事项」里也有他自己记的事。别家早报都读日历。CC 读得到,早报才像个管家:「今天 10:00 和设计评审,下午 3 点前要交报销」。

**成功的样子**:主人在微信说「日历 开」,Mac 上弹一次授权框,点允许;之后每天的早报里有今天的日程和到期的提醒;说「日历」/「日历 明天」能看那一天的安排。

## 不做 / 反目标

- 不做:写日历 / 改提醒 / 建事件(只读,脚本里没有任何写操作,测试钉住);读备注、参会人、视频会议链接(只取标题、时间、日历名、地点不取);Windows / Linux(只说「只在 Mac 上有」);给访客看。
- 反目标:没经主人当面同意就弹授权框;一次读一年的事件拖垮 daemon;日历标题当指令(进模型时包成数据);授权被拒了还反复弹。

## 怎么读

- `osascript -l JavaScript` 跑一段内嵌脚本,通过 JXA 的 ObjC 桥直接用 **EventKit**(`EKEventStore`)—— 不新增原生二进制。10-20 已在本机核对:桥可用,`requestFullAccessToEventsWithCompletion` 在。
- osascript 是 daemon 的子进程,授权记在责任进程(Tendhearth CC 主二进制)上 ⇒ 弹框显示「Tendhearth CC」,用途说明取 app 的 Info.plist。
- 只读:`eventsMatchingPredicate`(时间窗)+ `fetchRemindersMatchingPredicate`(未完成、到期 ≤ 窗口末)。异步回调靠 `NSRunLoop.runUntilDate` 等,脚本 15 秒自停,daemon 20 秒杀。
- 输出 JSON:`{status, events:[{title,start,end,allDay,calendar}], reminders:[{title,due,list}]}`;最多 50 + 50 条,标题截 120 字。

## 授权

- **只在主人亲口要时请求**:「日历 开」⇒ 先看包里有没有用途说明(读 app 的 Info.plist);没有 ⇒ 「要等新版本的 Tendhearth CC(1.7.8 起)」,不去请求。有 ⇒ 请求事件 + 提醒两项完全访问,Mac 上弹框;回主人「Mac 上弹了一个框,点允许」+ 结果。
- 状态四态:`not_determined` / `granted` / `denied` / `unavailable`(不是 Mac / 包太旧)。拒了 ⇒ 告诉主人去「系统设置 → 隐私与安全性 → 日历 / 提醒事项」,不再自己请求。
- 「日历 关」⇒ CC 不再读(开关存 state 里);系统授权要收回得去系统设置,照实说。
- 读的时候从不请求:状态不是 granted 就当没有日历。

## 用在哪

1. **早报素材**(#414):开着且授权了 ⇒ 多两块「今天的日程」「今天到期的提醒事项」;读失败就省略,不挡早报。
2. **微信 / 桌面命令** `日历` / `日历 明天` / `日历 开` / `日历 关` / `日历 状态`:只认主人。
3. (下一步,不在这一版)给对话侧一个只读工具,让 CC 回答「我明天几点有会」。

## 包要改的(随 1.7.8 发)

- `Info.plist`:`NSCalendarsFullAccessUsageDescription`、`NSRemindersFullAccessUsageDescription`(macOS 14+),以及旧键 `NSCalendarsUsageDescription`、`NSRemindersUsageDescription`;`lproj/en.lproj/InfoPlist.strings` 英文版。
- `entitlements.plist`:`com.apple.security.personal-information.calendars`(hardened runtime 下读日历 / 提醒都要)。
- `self deploy` 只换 sidecar,换不了 Info.plist / entitlements ⇒ 真机验要等 1.7.8 装上。

## 测试要钉住的

- 脚本:只出现读的 API(不含 `save` / `remove` / `commit` / `requestAccess` 之外的写);请求授权的脚本和读的脚本分开,读的脚本里不请求。
- 解析:合法 JSON ⇒ 结构;超量截断;非 JSON / 超时 / 退出码非 0 ⇒ 读失败(不抛进早报)。
- 开关与授权:没开 ⇒ 不读;包里没用途说明 ⇒ 不请求、说清要新版本;denied ⇒ 不再请求、指路系统设置;非 Mac ⇒ unavailable。
- 早报:有日程 ⇒ 两块出现在 `<material>` 里;读失败 ⇒ 省略。
- 命令:只认主人;`日历 明天` 取明天那一天(按主人时区)。
