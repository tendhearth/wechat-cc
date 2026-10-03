# apps/mobile —— Tendhearth CC 浏览器手机页(/m)

这是浏览器/PWA 入口；原生 Expo app 在 [apps/app](../app/README.md)。产品名与技术标识遵守[命名规范](../../docs/reference/product-naming.md)。

daemon 在 `/m` 服务的 PWA。源码在 `src/`,构建期组装成 `src/daemon/mobile-page.generated.json`(提交进仓库),daemon 只读这份生成物。

## 改页面

1. 改 `src/` 下的文件。
2. `bun run build:mobile`
3. `bun run typecheck && bun --bun vitest run apps/mobile src/daemon/mobile-page src/daemon/settings-panel`

忘了第 2 步,`apps/mobile/build.test.ts` 会红。

## 规矩(都有测试或 depcheck 盯着)

- **整份内联。** 公网壳页 `relay/pset.html` 通过隧道取到页面后 `document.write` 整份写入,没有可用的相对路径 —— 不许外链脚本 / 样式表。
- **第一个 `<script>` 保持裸标签并定义 `T`。** 壳页往第一个 `<script>` 里注入 `window.__CC_SHELL__`。
- **经典脚本,不是 ES module。** `boot.js` → `transport.js` → `nav.js` → `markdown.js` → `workbench.js` → `presence.js` → `you.js` → `home.js` 按 `phone.html` 的包含顺序共享全局(`esc`、`api`、`toast`、`openMatter`…)。
- **安全 Markdown。** `markdown.js` 在工作台前内联 `packages/markdown/src/browser.ts` 的生成 IIFE(`globalThis.CCM`)。助手正文、已发送且有格式的用户消息和 Markdown 成果使用它;有格式的用户消息附「查看原文」,原文保留空白与换行,刷新保持展开状态,普通消息不加控件。输入框、待发送草稿、工具/权限/系统/错误原文、纯文本与 JSON 保留原样,摘要只去排版语法。成果同时保留折叠原文与完整下载;不加载正文里的外部图片。阅读排版不修改存储或发送的文字。
- **行首不许是 `(` 或 `[`。** 脚本不写分号,行首括号会被 ASI 接到上一行当调用 —— 类型转换 `/** @type {X} */ (el)` 放行首就中招,先绑到局部变量。
- **两种标记。** `{{>file}}` 构建期包含;`{{UPPER_KEY}}` 运行时键,只认 `assemble.ts` 的 `RUNTIME_VARS`,由 `src/daemon/mobile-page.ts` 单趟填。
- **只走 HTTP。** 本目录不 import `src/`,daemon 不 import 本目录(depcheck)。
- **512KB。** 整页 base64 后加信封要塞进中继一帧(`src/daemon/mobile-page-presence.test.ts`)。

## 额度接手

任务详情按后端 `quotaHandoff` 显示可接手、目前无人可接或已接手的真实状态。接手前重新读取详情并明确确认：同一个文件夹由另一位执行者新开一件，只带标题与继续原要求，不带旧会话。提交只调用 `POST /m/api/matter/handoff`，不走普通创建。

确认后的 `requestId`、执行者与原确认保存在该任务独立的本地记录中。未知回包、刷新和重连只读状态；手动核对才沿用同一请求与原执行者提交一次。候选后来改变也不能替换未知确认；明确拒绝后才允许重新确认新候选。直连失败不会把同一个 POST 自动再发到隧道。迟到结果不会打开在其他页面之上的任务，也不修改补充草稿。

交互回归见 `quota-handoff.test.ts`，真实组装页面验收运行 `bun apps/mobile/__e2e__/quota-handoff.browser.mjs`，使用合成数据与拦截请求，截图和证据写入 `/tmp/tendhearth-pwa-quota-handoff-qa`。

## 类型

`tsconfig.json`:DOM lib + `checkJs`,`strict` 暂关;`sw.js` 不在检查范围。DOM 取回的元素用 JSDoc 转换:`/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value`;回调参数用 `function(/** @type {HTMLButtonElement} */ b){…}`。

## 不在这里的

`/set` 设置页(`src/daemon/settings-panel-html.ts` 的 `pageHtml`)还在 daemon 里,只是内联了这里的 `transport.js`。
