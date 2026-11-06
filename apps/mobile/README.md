# apps/mobile —— Tendhearth CC 浏览器手机页(/m)

这是浏览器/PWA 入口；原生 Expo app 在 [apps/app](../app/README.md)。产品名与技术标识遵守[命名规范](../../docs/reference/product-naming.md)。

daemon 在 `/m` 服务的 PWA。T5 设备入口直接进入唯一主人对话；短链接仍是原受限状态后备页，不读私人对话、话题或批准正文。新界面随 daemon 的手机页面资产部署，不代表桌面或原生 App 已发行。

| 网页功能 | 唯一入口 |
| --- | --- |
| 在场与连接、设置 | 页头小 CC、连接提示与原 `/set` |
| 文字、历史、授权附件读取 | 主人对话与输入区；不新增录音或上传 |
| 进展、结果、等你、新变化 | 稳定 CC 事项引用；输入上方待响应定位器 |
| 旧事项、项目/状态/归档、更多历史 | 对话搜索层；无话题的旧事也可检索，原创建时间标「以前交办的事」 |
| 事项状态、过程、成果、停下 | 从消息/泡泡进入详情，停下仍二次确认并绑定 runId |
| 权限批准/拒绝、结构化问题回答 | 设备详情响应层，核对 runId/requestId；其他类型转 App/电脑 |
| 终端投影 | 搜索类型选择「终端会话」后打开原详情；不新增终端输入或接管 |
| 六个最近话题、旧话题搜索、来源和回看 | 输入上方话题行与单个面板；收起只影响本机选择 |
| 配对、短链接有效期 | 原引导和配对条；配对后进入同一对话 |
| 刷新、断线、PWA 更新 | 对话连接区/刷新；保留不含令牌的离线界面模板，不缓存带凭据 HTML 或私人 API |

`conversation:v1` 与 `topics:v1` 在设备对话分页响应中分别声明，不能以 routes:v1 代替。旧 daemon 不支持时保留受限后备入口并提示转 App/电脑。网页不扩展 diff、工作区、交办表单等原非网页工程工具。

源码在 `src/`,构建期组装成 `src/features/phone/mobile-page.generated.json`(提交进仓库),daemon 只读这份生成物。

## 改页面

构建、验证和浏览器截图均在 [Mac mini 离线 lab](../../docs/maintainer/macmini-ui-lab.md) 执行；主工作 Mac 只编辑源码。

1. 改 `src/` 下的文件。
2. `bun run build:mobile`
3. `bun run typecheck && bun --bun vitest run apps/mobile src/features/phone/mobile-page src/features/phone/settings-panel`

忘了第 2 步,`apps/mobile/build.test.ts` 会红。

## 规矩(都有测试或 depcheck 盯着)

- **整份内联。** 公网壳页 `relay/pset.html` 通过隧道取到页面后 `document.write` 整份写入,没有可用的相对路径 —— 不许外链脚本 / 样式表。
- **第一个 `<script>` 保持裸标签并定义 `T`。** 壳页往第一个 `<script>` 里注入 `window.__CC_SHELL__`。
- **经典脚本,不是 ES module。** `boot.js` → `transport.js` → `nav.js` → `workbench.js` → `presence.js` → `home.js` → `conversation.js` / `delegation.js` / `topics.js` / `search.js` / `responses.js` / `files.js` / `layers.js` / `entry.js` 按 `phone.html` 的包含顺序共享全局(`esc`、`ccPlain`、`api`、`toast`、`openMatter`…)。
- **安全文本。** 对话、过程与来源只渲染安全文本；标题经 `boot.js` 的 `ccPlain` 去掉排版记号再 `esc`。
- **行首不许是 `(` 或 `[`。** 脚本不写分号,行首括号会被 ASI 接到上一行当调用 —— 类型转换 `/** @type {X} */ (el)` 放行首就中招,先绑到局部变量。
- **两种标记。** `{{>file}}` 构建期包含;`{{UPPER_KEY}}` 运行时键,只认 `assemble.ts` 的 `RUNTIME_VARS`,由 `src/features/phone/mobile-page.ts` 单趟填。
- **只走 HTTP。** 本目录不 import `src/`,daemon 不 import 本目录(depcheck)。
- **512KB。** 整页 base64 后加信封要塞进中继一帧(`src/features/phone/mobile-page-presence.test.ts`,预算 420KB)。

## 短链接后备页的事项详情

短链接与旧 daemon 后备模式下，`workbench.js` 的详情只读 `GET /v1/matter`,画标题、执行者、一个状态词(照 [用词表](../../docs/reference/phone-wording.md))、正在跑的那一步、等你决定的项数、额度用完 / 已交出这类状态句;唯一能按的是「停止这一轮」(点一下要确认,再点才发一次 `POST /v1/matter/stop`,不换通道重发)。回归见 `src/features/phone/mobile-page-workbench.test.ts` 与真浏览器的 `src/daemon/__e2e__/mobile-workbench.e2e.test.ts`。

## 类型

`tsconfig.json`:DOM lib + `checkJs`,`strict` 暂关;`sw.js` 不在检查范围。DOM 取回的元素用 JSDoc 转换:`/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value`;回调参数用 `function(/** @type {HTMLButtonElement} */ b){…}`。

## 不在这里的

`/set` 设置页(`src/features/phone/settings-panel-html.ts` 的 `pageHtml`)还在 daemon 里,只是内联了这里的 `transport.js`。
