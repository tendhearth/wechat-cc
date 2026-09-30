# apps/app —— Tendhearth 手机 app(Expo 原生)

「自己电脑上的个人 AI + 指挥编码 agent」的手机端。这一版有**演示模式**与**真连接**:没配对时是演示后端;扫码配对后换成 `src/backend/live.ts`,经中继连回家里的电脑。

- 设计:`docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`,设计稿 `docs/design/tendhearth-app-v1/`
- 计划:`docs/superpowers/plans/2026-09-30-tendhearth-app-skeleton.md`(骨架 + 演示)、`docs/superpowers/plans/2026-09-30-tendhearth-app-live.md`(真连接与配对)

## 怎么跑

```bash
bun install                      # 仓库根目录,一次
cd apps/app
bunx expo start                  # 开发服务器(连已装的 development build)
bunx expo run:ios                # 首次:生成 ios/ 并在模拟器装 development build
bun run test                     # vitest(纯逻辑,node 环境)
bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts   # 仓库根目录:LiveBackend 对着进程内真 daemon 的端到端
bun run typecheck                # tsc --noEmit(本工程自己的 tsconfig)
bun run export:check             # expo export 两个平台,证明能打包
maestro test .maestro/           # 模拟器上跑演示流程(要先有 development build + 开着 expo start)
```

- 加了 `expo-crypto` / `expo-camera` 之后要重新 `bunx expo run:ios` 生成 development build,模拟器才有这些原生模块。
- `ios/`、`android/` **不进 git**(`.gitignore` 已列);原生部分以后走 Expo config plugin,保持「预构建可重生」。
- `expo start` / `expo prebuild` 可能改写 `tsconfig.json` / `package.json`,别把这些改动提交。
- 换过 bundle 相关的东西后用 `bunx expo start --clear`,免得模拟器拿到旧 bundle。
- 本工程有自己的 tsconfig 与 vitest;根 `bun run typecheck` 末尾追加了 `tsc --noEmit -p apps/app`,所以根回路也会检查本工程。根目录端到端 `src/daemon/phone-app-live-e2e.test.ts` 会 import 本工程的一部分文件(见下「真连接的规矩」),那些文件要同时过根 tsconfig。

### Maestro

装:`brew tap mobile-dev-inc/tap && brew trust --formula mobile-dev-inc/tap/maestro && brew install --formula mobile-dev-inc/tap/maestro`(注意是 formula;不带 `--formula` 会装成桌面版 Maestro Studio 的 cask)。要 Java,formula 会带上 openjdk。

| 流程 | 走什么 |
|---|---|
| `.maestro/approve.yaml` | 先看看 → 此刻第一张「等你决定」卡 → 批准页**原始命令直接可见** → 允许 → 进展页 → 2 秒后「这一轮已回复」 |
| `.maestro/compose.yaml` | 此刻 → 跟 CC 说一句 → 输入 → 交给 CC → 新事项的进展页 → 「一起做」里出现它 |
| `.maestro/demo-walkthrough.yaml` | 欢迎 → 先看看 → 此刻 → 一起做 → 某件事 → 展开改动 / 过程 → 设置 → 切语言 → 退出演示回欢迎页 |
| `.maestro/pair-invalid.yaml` | 欢迎 → 配对 → 粘贴无效链接 / 局域网链接 → 各自的提示(不联网;真配对是主人真机验收) |
| `.maestro/subflows/_start.yaml` | 共用开头:`clearState` 启动、收掉开发构建偶尔弹的系统框「Open in "Tendhearth"?」、等欢迎页 |

同时开着多台模拟器时加 `--device <UDID>`。流程只认 `testID` 和中英两份文案(正则 `中|英`),不依赖系统语言。

## 目录

```
src/app/          expo-router 页面:(tabs)/ 此刻 index + 一起做 together;welcome、pair、compose、settings、
                  matter/[id](进展页)、approval/[id](批准页 + 问答表单)
src/backend/      Backend 接口(types.ts)与演示后端(demo.ts + demo-data.ts 的中英文案)
src/net/          真连接:connection.ts(连接状态机)、errors.ts(错误映射)、link.ts / pairing.ts(配对链接与配对)、credentials.ts(钥匙串)、ws-socket.ts / rn-connect.ts(RN 传输)、uuid / utf8 / polyfills
src/state/        BackendProvider、会话(语言覆盖、已看过欢迎页;配对记录与偏好落钥匙串 `tendhearth.pairing.v1` / `tendhearth.prefs.v1`)、订阅 store、查询 hooks、草稿
src/view/         纯函数视图模型(此刻 / 一起做 / 进展 / 批准 / 状态词),vitest 覆盖
src/i18n/         en 与 zh-Hans 文案表(两份键一致有测试)+ useLang(设置覆盖 ?? 系统)
src/ui/           组件与色板(tokens.ts,明暗两套;明暗只是外观,不表示在线离线)
.maestro/         模拟器演示流程
```

## 界面只认 Backend 接口

页面只通过 `src/backend/types.ts` 的 `Backend` 拿数据和提交动作(订阅主题、`matter` / `insight` / `changes` / `decide` / `answer` / `say` / `create` …)。演示后端在 `src/backend/demo.ts`:三件种子事(作品集 `a1b2c3d4` 带一条模型说明的待批准、零散想法 `e5f6a7b8` 已回复、出差 `c9d0e1f2` 带一个问题),动作后 2 秒推进到「这一轮已回复」;设置里「退出演示」会重置。
真后端在 `src/backend/live.ts`(纯 TS,socket 注入);连接状态机 `src/net/connection.ts`;错误映射 `src/net/errors.ts`;配对 `src/net/pairing.ts` + `src/app/pair.tsx`;钥匙串 `src/net/credentials.ts`(键 `tendhearth.pairing.v1` / `tendhearth.prefs.v1`)。界面不用关心用的是哪个。

## 真连接的规矩

- **只走中继**:`r…` daemon id ⇒ `wss://<中继主机>/v2/phone?id=<id>`;`t…` id ⇒ `wss://<中继主机>/tunnel/phone?id=<id>`。链接里的 `lan=` 解析并记下,但**不使用**(daemon 的局域网口没有 v2 订阅,见计划裁决 1)。
- 所有接口返回都过 `PHONE_API_SCHEMAS` 的 zod schema,主题事件过各自的 Topic schema;解析失败 ⇒ 事件丢弃并记日志,请求抛 `BackendError('unknown')`。
- 错误映射只在 `src/net/errors.ts` 一处:`permission_stale / question_stale / input_stale` ⇒ `stale`;`auth_failed` 或 HTTP 401 ⇒ `revoked`;`timeout` ⇒ `timeout`(界面当「不确定」);`unreachable / daemon_offline / closed / stream_unknown / rate_limited / quota_exceeded / too_many_streams` 及未知传输错误 ⇒ `offline`;`matter_not_found` ⇒ `not_found`;`invalid` 与 `invalid_*`(含 `invalid_answer`)⇒ `invalid`;其余 ⇒ `unknown`。
- 上限:回答 `JSON.stringify(answers).length > 20_000`、说一句正文 `> 20_000` 字,在手机上就拦下,不发(协议包常量 `PHONE_ANSWER_MAX_JSON` / `PHONE_SAY_MAX_CHARS`)。
- **撤销 ≠ 离线**:撤销 ⇒ 停止提交、清掉钥匙串里的设备令牌、显示「重新配对」;暂时离线 ⇒ 显示上次同步时间、草稿照写、发送 / 批准 / 拒绝锁住。两者文案与 testID 都不同。
- **草稿永不自动发送**:重连后只重拉读,不重放写;不做乐观成功。
- **令牌不进日志**、错误文案或 `console`:`LiveBackend` 的 `log` 只写错误码与路由键。
- **被根测试 import 的文件必须纯 TS 且过根 tsconfig**:`src/backend/{live,types}.ts`、`src/net/{connection,errors,uuid,link,pairing}.ts`、`src/i18n/{index,en,zh-Hans}.ts` 不 import `react` / `react-native` / `expo-*`;类型用 `import type`,数组下标取值带 `!` 或判空(根有 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`)。

## 硬要求(改界面前先对一遍)

- **批准页**:说明来自模型(`source === 'model'`)时,原始命令第一行与工作目录**不折叠、直接可见**(`approval-raw-inline`,Maestro 断言它);完整原始命令在「查看具体操作」里;提交中锁定按钮;以返回结果为准,不做乐观成功;超时 ⇒ 当「不确定」并重新拉详情。
- **进展页**:状态标签在「CC 的进展」概括之上。
- **状态词**只用:正在整理 / 等你决定 / 这一轮已回复 / 事情完成 / 没做成 / 已停下(Working on it / Waiting for you / Replied this round / Done / Didn't finish / Stopped),不显示百分比。
- **导航**:底部「此刻 / 一起做」;右上角头像进设置,旁边是「家里的电脑」状态点;说一句的入口随处可见。
- **语言**:`en` 与 `zh-Hans`,跟随系统、设置里可改;所有面向用户的字符串进文案表。
- **隐私页**要说明:打开此刻、进展或批准页时,待批准的命令文本和任务的进展事件会从主人自己的电脑发给那里配置的便宜模型服务商;其余只在手机与电脑之间加密传输(`i18n.test.ts` 钉住)。
- 系统「减少动态效果」时关掉 CC 动作;所有状态都有文字。
- CC 形象只用 `apps/desktop/src/assets/pet/cc-v1/canonical/{lit,unlit}/front.png`,不重画。
