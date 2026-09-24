# apps/mobile —— 随身 CC 手机页(/m)

daemon 在 `/m` 服务的 PWA。源码在 `src/`,构建期组装成 `src/daemon/mobile-page.generated.json`(提交进仓库),daemon 只读这份生成物。

## 改页面

1. 改 `src/` 下的文件。
2. `bun run build:mobile`
3. `bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel`

忘了第 2 步,`apps/mobile/build.test.ts` 会红。

## 规矩(都有测试或 depcheck 盯着)

- **整份内联。** 公网壳页 `relay/pset.html` 通过隧道取到页面后 `document.write` 整份写入,没有可用的相对路径 —— 不许外链脚本 / 样式表。
- **第一个 `<script>` 保持裸标签并定义 `T`。** 壳页往第一个 `<script>` 里注入 `window.__CC_SHELL__`。
- **经典脚本,不是 ES module。** `boot.js` → `transport.js` → `nav.js` → `workbench.js` → `presence.js` → `home.js` 按 `phone.html` 的包含顺序共享全局(`esc`、`api`、`toast`、`openMatter`…)。
- **行首不许是 `(` 或 `[`。** 脚本不写分号,行首括号会被 ASI 接到上一行当调用 —— 类型转换 `/** @type {X} */ (el)` 放行首就中招,先绑到局部变量。
- **两种标记。** `{{>file}}` 构建期包含;`{{UPPER_KEY}}` 运行时键,只认 `assemble.ts` 的 `RUNTIME_VARS`,由 `src/daemon/mobile-page.ts` 单趟填。
- **只走 HTTP。** 本目录不 import `src/`,daemon 不 import 本目录(depcheck)。
- **512KB。** 整页 base64 后加信封要塞进中继一帧(`src/daemon/mobile-page-presence.test.ts`)。

## 类型

`tsconfig.json`:DOM lib + `checkJs`,`strict` 暂关;`sw.js` 不在检查范围。DOM 取回的元素用 JSDoc 转换:`/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value`;回调参数用 `function(/** @type {HTMLButtonElement} */ b){…}`。

## 不在这里的

`/set` 设置页(`src/daemon/settings-panel-html.ts` 的 `pageHtml`)还在 daemon 里,只是内联了这里的 `transport.js`。
