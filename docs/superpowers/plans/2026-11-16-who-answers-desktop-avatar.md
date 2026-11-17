# PR 6 桌面回复圆标：实现完成，待 CI / mini 验收

状态：**桌面实现与定向回归完成；尚未完成原生验收，不可直接部署**。工作区 `wt-who-answers-desktop`，分支 `who-answers-desktop-avatar`，基线 `087dbf9f87b87242fe7f28ac51368c597efd8c5d`。本轮整合者已允许修改 Rust 桥接；根代理仍为本工作区唯一写入者，两个只读代理调查/复核。未改 daemon、`packages/protocol` 或共享圆标表。没有 git add / commit，原有暂存内容保留，本轮修改留在工作区。

依据：[设计稿](../specs/2026-11-16-who-answers-design.md) §3、§5 PR 5/6、§6.2；网页版 `origin/who-answers-web-avatar`。仅 `role=cc && speaker=agent && provider` 为非空字符串时露实际一家共享圆标；CC 保留 CC、通知无标、旧消息不猜来源；openai 使用通用服务标，名字取 owner-chat/model 的 providers，失败退 provider id。

上一轮阻塞成立：`webview_converse_reply` 只重建 `{ reply, attachments, narration }`，丢掉 daemon 的来源字段。本轮已在 `apps/desktop/src-tauri/src/lib.rs` 补上 `speaker`、`provider`、`replyParts`、`model`、`agentId` 的存在字段原样透传；缺失不插入，显式 null 不改写，附件路径仍按原逻辑转成 ref。新增两条 Rust 单测覆盖混合 parts / 全字段、独立存在 / null / 任意原值 / 不造默认值；既有旧 daemon 精确断言和附件路径安全测试保留。**只写，未编译，交 CI 跑。**

名称接口仍有真实边界：`owner-chat/model` 当前仅登记 phone，处理器也只装在 settings panel；桌面宿主名单、operator 范围与 daemon 本地分发均未接通。遵守不改协议包的要求，在 `scripts/gen-routes.ts` 给已有路由补桌面可选 `V1.matter.ownerChatModel` 键，运行 `bun run gen:routes` 生成 `daemon-calls.js`，没有手改生成物或扩大权限。前端尝试读取 `providers[].name`，失败退 provider id；**本次不能宣称原生自定义名称接口已接通**。已向整合者说明，后续若要求原生显示设置名，需另补协议与 daemon 装配。

本轮前端实现：

- 新增 `reply-avatar.js`：统一逐条来源判断、共享圆标、可选名称读取与标签原位更新。openai / 未知服务固定通用 A 圆标，名称只进读屏和悬停，不随自由模型名猜品牌。
- `converse.js`：历史 window、fallback 历史、即时回复、实时事件、带回结果均取自己的来源；混合 parts 在父消息内分行渲染，附件/旁白只显示一次，保留分段截断省略号和逐段朗读。
- `converse-reading.js`：稳定消息签名比较 speaker / provider / parts 及附件/旁白；同 id 历史来源更新生效。名称迟到只原位改标签，不替换正文节点。
- `workbench.js`：整页与增量共用同一逐事件 renderer；CC 保留 CC，接力历史不跟当前 task provider 换标。名称从整页重画签名中排除，避免后续轮询为名称更新再次替换正文。
- `converse.css`：圆标与分段布局，正文保持可收缩；宽窄屏视觉效果待 mini 验收。

上一轮保留的红测与 mini 入口，本轮全部保留并加测：

- `apps/desktop/src/modules/converse-avatars.test.ts`：原 5 条红测已绿，新增 3 条覆盖过滤后的附件/旁白索引与历史文件原始索引、同 id 来源/parts 更新且其他正文不重画、分段截断；另增通用圆标固定及名称迟到不改内层字形断言。
- `apps/desktop/src/modules/workbench-reply-avatar.test.ts`：原 1 条红测已绿，新增 1 条验证名称原位更新后再次 paint 不重画正文。
- `scripts/client-paths.guard.test.ts`：新增生成调用键及 GET 请求形状断言。
- `apps/desktop/playwright/t5-conversation.spec.ts` 末尾：1 条浏览器用例，mock 来源和名称，检查 1280/390 宽度、读屏属性、通用标、事项层、旧消息和切后端回看。**只写，未运行**。
- `macmini-browser-snapshot.mjs`：只加入本任务分支白名单；`macmini-ui-entry.test.mjs` 新增 1 条分支隔离测试，App 白名单不变。

验证记录：

- 先增测试再尝试实现，首轮主对话 5 条、事项 1 条、白名单 1 条均红；事项测试修正 fixture 空白定位后确认因缺头像而红。
- 上轮撤下实现后的定向命令：**6 条预期失败、14 条通过**，作为红测证据保留；本轮先前这 6 条全部转绿，未删除/放松既有测试。
- 本轮最终定向 vitest（`--maxWorkers=1`）：converse-avatars、workbench-reply-avatar、macmini-ui-entry、既有 converse、converse-reading、workbench、workbench-live、workbench-reading-dom、converse-media、client-paths、route-registry、desktop-ts-check，**12 文件 / 291 条通过**，无未处理错误。
- `bun run gen:routes --check` 通过；`bun run depcheck` 通过（0 error，既有 16 warning）；根 TypeScript 检查（`bunx tsc --noEmit --pretty false --incremental --tsBuildInfoFile /private/tmp/who-answers-desktop-avatar.tsbuildinfo`）与 `git diff --check` 通过。
- 两位只读代理已复核桥接/生成表及前端正确性；复核发现的名称导致下次轮询重画、parts 截断提示、通用圆标字形随名称变动均已修复并加断言。

保留注意事项：附件/旁白的原始索引或 parts 索引必须重映射；历史打开文件还必须使用持久化原始附件索引，不能误用过滤后下标。读取中的稳定消息键比较 speaker/provider/parts；名称迟到只原位更新标签。归属中的 matterId 不写进 ConverseMsg.matterId（后者表示事项引用）。这些约束本轮已实现并覆盖测试。

未运行 / 交整合者：

- CI：Rust 单测与三平台检查；本机没有运行 cargo / tauri 编译。
- mini：上述 Playwright 用例及相关 UI 回归，宽窄屏长回复/附件不横溢、Claude→Codex 接力旧标不变、CC/通知/无来源、通用标、断线重连、读屏名称；原生即时回复须验证真实桥接，浏览器 mock 不能替代。
- `bun run verify` / 全部守卫 / 真实形状沙盒未跑：verify 会运行需要监听端口的沙盒并写验证记录，当前沙盒禁止 listen / git index.lock，重型项目检查也不放在主 Mac。请整合者在允许的隔离环境补齐。
- 真模型双跑由整合者在受保护主机隔离执行。未操作 daemon、生产数据库、`~/.claude/channels/wechat`、已安装 App、launchctl 或 self/companion 命令；未跑本机 Playwright、截图、模拟器、重型构建；未暂存、提交、部署或推送本轮改动。
