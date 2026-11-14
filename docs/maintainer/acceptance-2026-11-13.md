# 统一验收清单(2026-11-13):#915 #916 #917 #918

验收基线 `e3d65c530`（功能树 `7a95fb140`）有四块**已合入、未部署**的改动,都碰主人每天和 CC 对话的路径。离线测试与独立评审已过。真实运行结果单独记在 [逐项结果](acceptance-2026-11-13-results.md)，未通过不在验收分支修改生产代码。

## 怎么跑（主人 2026-11-13 更新）

- 主 Mac 只跑无界面真模型：真实 Claude / Codex 程序及 OpenAI 兼容通道，全部指向内部网关 `https://llm.youdamaster.cc`。Claude 用 `/v1/messages`，Codex 用 `/v1/responses`，OpenAI 兼容用 `/v1/chat/completions`。默认 Kimi-Code，备选 DeepSeek / GLM-FLASH，不使用订阅登录态。
- `scripts/acceptance/run.py` 前台监督临时 daemon，明确指定 `<验收临时目录>/acc/state/<run>`；空白 HOME、CLAUDE_CONFIG_DIR、CODEX_HOME，先证明没有订阅凭据文件。网关 key 仅进入子进程环境；模型子进程受只准回环出站的 sandbox 约束，回环代理固定转发内部网关并拒绝重定向。合成账号只连回环 fake ilink，不登录微信、不连中继/A2A/社交、不注册服务。
- 每次起跑同命令检查 load < 12，最多等 20 分钟，不检查游戏；不运行 UI、Playwright、模拟器或重型构建，不改网络保护状态。断言、日志和报告不输出环境全文或凭据；`ps` 在监督进程内存中比较，只给命中布尔与本次子进程数量。
- A→B→C→D 串行驱动；单项失败留最小复现后继续。`drive.ts` 保存合成 API/轮次证据，代理只记录请求结构、工具名/数量、状态、长度、隐私分类布尔及 usage，不保存请求正文。模型 SDK 的观察器仅用于凭据检查和编造体检工具取证，不替换模型/工具/评分实现。
- C.3、D.5 及 C.1 的截图对照标 **待 mini**；mini lab 仅离线夹具和本地模拟接口，见 [mini 规矩](macmini-ui-lab.md)，不复制网关 key、不调用真实模型。
- 真实 Claude 订阅专属的 SDK 模型名/窗口和超长错误文案标 **部署后只读复核**。网关经 Claude CLI 回报的容量不能当作订阅证据，也不能直接当作上游模型真实容量。
- ★ 的两个通道改为“真实 Claude 程序 + 网关模型”和“OpenAI 兼容 + 网关模型”；Codex 另验真实程序。结束停本次 daemon 及所有子进程，保留临时状态；脚本和文档提交，不 push。

```bash
# 用任务分配的 /private/tmp/ 下绝对临时目录替换占位；所有入口无显式临时状态目录都会拒绝。
export WECHAT_STATE_DIR="<验收临时目录>/acc/state/run-01"
export ACCEPTANCE_KEY_FILE="<验收临时目录>/acc/gateway.key" # 0600；不要 cat
python3 scripts/acceptance/run.py start # 留在前台；另一终端串行驱动
bun scripts/acceptance/drive.ts A
bun scripts/acceptance/drive.ts A-extra # 模式API、真delegate、手动回收续接
bun scripts/acceptance/drive.ts A-codex
bun scripts/acceptance/drive.ts A-long # >60秒、<10分钟的真实委派
bun scripts/acceptance/drive.ts B
bun scripts/acceptance/drive.ts B-extra # A遗留冷却结束后的记账/五分钟节流补验
bun scripts/acceptance/drive.ts B-openai20
bun scripts/acceptance/drive.ts C
bun scripts/acceptance/drive.ts D
bun scripts/acceptance/drive.ts D-fallback # 单独标注备选模型结果
python3 scripts/acceptance/run.py ps
python3 scripts/acceptance/run.py stop
# 仅先前已清理、无残留、无登录凭据的本次合成状态可显式 resume；保留代理端口以复核持久容量。
python3 scripts/acceptance/run.py resume
```

真实30分钟空闲回收另留一份合成状态，观察 `sessions_live=0` 后才跑 `drive.ts A-idle`。`B-lab` 在另一份全新临时 daemon 上跑喝茶指代和已知半预算夜整；它与包含超长失败历史的 B 状态分开。所有驱动都自带同命令 load<12 门禁，不检查游戏。D 入口自动种下并核验合成记忆、话题、对话 canary；只对实际体检请求作隐私判定。C 用唯一目录/批次核对产物，临时 Claude wrapper 仅为 C.5 注入启动失败。

每项记录：通过 / 不通过 / 做不了（原因）及脱敏证据；局部通过必须写清未覆盖部分。

## A. 对话令牌不进命令行(#917)——先验,它改的是每一轮对话

1. ★ 临时 daemon 用真实 Claude 程序 + 网关对话:发一句需要工具的话(如「今天有什么在办的事」),工具被正常调用、回复正常。
2. 同一时刻在监督进程内存里比对 `ps` argv 与模型子进程环境，命中均为 false；会话令牌取本次临时登记观察器，不将令牌放进 grep argv。必须观察到实际模型子进程，0个进程不算通过。
3. 模型看到的工具名仍是 `mcp__wechat__*`,数量与合入前一致;工具没有被折叠成「需要先搜索」而用不了。
4. `/both`、`/chat` 当前只提示去桌面；先验证此现行行为，再用内部 set-mode 开 parallel/chatroom，合成入站各发一句，各家工具可用。圆桌须等结束，避免排队的 `/stop` 中止下一条。
5. 空闲 30 分钟被回收后再发一句:续接成功,工具仍在。
6. delegate(让 CC 问一下另一家)一次,10 分钟内的长调用不被掐断。
7. Codex 对话、OpenAI 兼容对话各一句:工具可用;子进程环境不含继承的令牌。

## B. 上下文轮换与当场记账(#918)

1. ★ `wechat-cc status`(或 `/v1/health.owner_context`)显示:窗口及来源、比例来源、固定开销、历史占用、预算。Claude 的窗口应是 SDK 回报并持久化的值(不是 32k 假设);重启 daemon 后仍在。
2. ★ 连续聊 20 轮(含工具调用):Claude 下不发生按量轮换;日志无 `[CONTEXT_ROTATE]`。
3. 网关模型:确认网关是否回报 usage(状态里占用不是「未知」)。不回报 → 记为发现,决定是否给该通道加字节估算兜底。
4. 人为把预算压小(lab 配置里给该模型一个小窗口),聊到越过预算:在两轮之间换段;换后说「刚才那个」能接上;回复没有明显变慢;日志一行 `[CONTEXT_ROTATE]`。
5. 超长兜底:给模型配一个比真实窗口大的假窗口,用各自未超窗的分块累积历史到真实超长——看真实错误文案是否被认成 `context_overflow`、是否自动换段重试成功。认不出 → 保留脱敏原文案，另开修复，不在验收分支补识别表。
6. 当场记账:说一句明确的决定(「以后周报都发周五」),这一轮回复之后几分钟内话题里出现这条;5 分钟内再说一条不重复触发。
7. 定时动作:触发一次主动消息,主人会话的占用不因它增长;随后回「好啊」,CC 知道指的是哪条。
8. 夜间整理后:占用不到半预算不换;白天不出现迟到的夜间轮换。
9. 访客对话、群:行为与部署前一致(不轮换、定时动作照旧)。

## C. 记录本与手动接力(#915)

1. 普通单执行者任务:详情页、话题里的结论、开场提示与部署前一致(对比一条部署前的任务截图)。
2. 真 Codex 做一件小事(生成一个文件并写一条交接备注)→ 对 CC 说「让 Claude 接着做 …」:CC 先向主人确认;同一工作区起第二棒;Claude 的开场里有记录本(备注 + 产出指针),没有 Codex 的对话原文;Claude 按备注用到了那个文件。
3. 桌面与 App 详情:出现执行者一列(Codex 做完 / Claude 在做)和「记录」;没接力的任务没有这两块。
4. 第二棒里让 Claude 调 `matter_notes` / `matter_note`:读得到、写得进;换一件事的任务里伪造读这件事 → 被拒。
5. 第二棒起步失败后说「继续」:新的一棒仍拿到记录本。
6. 这件事做完后,话题里有一条有意义的标题行(不是套话),正文不含绝对路径。
7. ★ 用网关模型当对话模型重做第 2 步:`matter_handoff` 能被正确调用(弱模型调不对 → 记为发现)。

## D. 体检(#916)

1. ★ `wechat-cc checkup --estimate`:给出请求数与 token 估算;不确认不开跑。
2. ★ 跑短版:完成后出评语(七项 + 办事 + 快慢),标题是 CC 的名字 + 当前模型,无「管家」字样,无总分;取消一次,档案不被半截结果覆盖。
3. 人工抽查评分是否合理:读一遍假工具记录,挑 3 个考点对照代码判的结果(尤其「分寸」「立场」),判错 → 记为发现。
4. 出站内容抽查:抓一次体检的实际请求体,确认只有系统提示、编造故事、人设的称呼 / 自称 / 口吻;没有真实记忆、话题、对话、执行者名。
5. 桌面与 App:「CC 现在怎么样」里的状态与评语、估算确认、取消、每周探针开关(默认关)。
6. Codex / agy 当对话后端:显示「没测成」及原因,不显示成弱。
7. 体检结果进了 B.1 的预算(比例来源变成「实测」)。

## 通过之后

1. 部署前照常:确认没有在跑的交办任务;`self ship` 从整合树(detached `origin/dev`)执行;v112 迁移只加表。
2. 部署后在主人真机复核 A.1–A.3、B.1(只读检查,不往主人微信发测试消息;要发先问主人)。
3. 一次优雅重启后 `wechat-cc self soak --min-restarts 1`。
4. 不通过的条目:修复走 PR,修完只重跑受影响的小节。
