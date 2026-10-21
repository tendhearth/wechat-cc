# apps/mobile —— Tendhearth CC 浏览器手机页(/m)

这是浏览器/PWA 入口；原生 Expo app 在 [apps/app](../app/README.md)。产品名与技术标识遵守[命名规范](../../docs/reference/product-naming.md)。

daemon 在 `/m` 服务的 PWA。2026-10-21 收敛(5b)后只剩:配对、此刻(CC + 一行状态 + 连不上提示 + 只看的「等你」卡)、一起做(列表 + 只看状态的详情 +「停下」)、右上角「设置」。对话、成果、交办、拍板、记忆、待办、画像都在手机 App([apps/app](../app/README.md))和桌面上。

源码在 `src/`,构建期组装成 `src/daemon/mobile-page.generated.json`(提交进仓库),daemon 只读这份生成物。

## 改页面

1. 改 `src/` 下的文件。
2. `bun run build:mobile`
3. `bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel`

忘了第 2 步,`apps/mobile/build.test.ts` 会红。

## 规矩(都有测试或 depcheck 盯着)

- **整份内联。** 公网壳页 `relay/pset.html` 通过隧道取到页面后 `document.write` 整份写入,没有可用的相对路径 —— 不许外链脚本 / 样式表。
- **第一个 `<script>` 保持裸标签并定义 `T`。** 壳页往第一个 `<script>` 里注入 `window.__CC_SHELL__`。
- **经典脚本,不是 ES module。** `boot.js` → `transport.js` → `nav.js` → `workbench.js` → `presence.js` → `home.js` 按 `phone.html` 的包含顺序共享全局(`esc`、`ccPlain`、`api`、`toast`、`openMatter`…)。
- **不渲染 Markdown。** 网页不显示对话正文,标题只经 `boot.js` 的 `ccPlain` 去掉排版记号再 `esc`。
- **行首不许是 `(` 或 `[`。** 脚本不写分号,行首括号会被 ASI 接到上一行当调用 —— 类型转换 `/** @type {X} */ (el)` 放行首就中招,先绑到局部变量。
- **两种标记。** `{{>file}}` 构建期包含;`{{UPPER_KEY}}` 运行时键,只认 `assemble.ts` 的 `RUNTIME_VARS`,由 `src/daemon/mobile-page.ts` 单趟填。
- **只走 HTTP。** 本目录不 import `src/`,daemon 不 import 本目录(depcheck)。
- **512KB。** 整页 base64 后加信封要塞进中继一帧(`src/daemon/mobile-page-presence.test.ts`,预算 420KB;5b 之后约 134KB)。

## 一件事的详情只看状态

`workbench.js` 的详情只读 `GET /m/api/matter`,画标题、执行者、一个状态词(照 [用词表](../../docs/reference/phone-wording.md))、正在跑的那一步、等你决定的项数、额度用完 / 已交出这类状态句;唯一能按的是「停止这一轮」(点一下要确认,再点才发一次 `POST /m/api/matter/stop`,不换通道重发)。回归见 `src/daemon/mobile-page-workbench.test.ts` 与真浏览器的 `src/daemon/__e2e__/mobile-workbench.e2e.test.ts`。

## 类型

`tsconfig.json`:DOM lib + `checkJs`,`strict` 暂关;`sw.js` 不在检查范围。DOM 取回的元素用 JSDoc 转换:`/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value`;回调参数用 `function(/** @type {HTMLButtonElement} */ b){…}`。

## 不在这里的

`/set` 设置页(`src/daemon/settings-panel-html.ts` 的 `pageHtml`)还在 daemon 里,只是内联了这里的 `transport.js`。
