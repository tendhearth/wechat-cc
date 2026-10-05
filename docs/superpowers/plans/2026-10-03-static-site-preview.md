# 静态网页成品预览 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for root integration. Agents provide isolated patches under /tmp; root is the only shared-workspace writer.

**Goal:** 在 CC 成果中交互查看含独立 CSS、JS、图片的完整静态网站，并下载当时保存的整份网页。

**Architecture:** 执行者在成果目录显式交付 `<名称>.site.json`，声明 entry 与 files；收集器只读取声明的普通文件，冻结成标准 ZIP（含 `__cc_preview.json` 入口元数据）。桌面从已保存 ZIP 校验并取出有限资源，交给现有隔离预览协议的内存资源映射；相对资源和站内导航使用同一版本，绝不读当前项目目录。

**Tech Stack:** TypeScript/Bun/Node, fflate 0.8.3, vanilla JS, Tauri/Rust, Playwright。

**Spec:** 用户本轮要求“成品网页、web preview、HTML、PDF”，及 docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md。

## Global Constraints

- 当前 dev，根 agent 单一写入者，不碰兄弟 checkout；保留已有改动。
- 主焦点为预览，主动作仍在原任务中继续修改；不新增顶层导航。
- 网站最多100个声明文件；原始资源总计不超过6 MiB，最终快照不超过既有8 MiB；路径只能为无 traversal、无链接的成果目录内路径。
- 已保存 HTML、PDF 阅读器保留；运行网页继续明确显示正在运行，冻结网站才提供版本确认。
- 不启动项目脚本，不发布网站；预览保持 opaque sandbox、禁止应用权限/任意网络/外部 frame/表单提交。

## Review Focus

- 旧网站重新打开：CSS/JS/图片与入口属于同一已保存版本。
- ZIP 伪造/超额解压：解压前检查路径、数量和累计解压尺寸；拒绝而非部分渲染。
- UTF8 路径/站内导航/资源 query：正确找到已冻结资源且无法绕到应用路径。
- module script 与 CSS 相对图片：在真实浏览器和 macOS WebView 中可用，opaque Origin null 的资源加载需要有限 CORS。
- 切换成果或离开任务：迟到 prepare 释放资源；既有 iframe 状态和草稿不丢。

### Task 1: Frozen website snapshot

Files: src/core/workbench/site-artifact.ts/.test.ts, artifacts.ts, service/execute.ts; package.json/bun.lock.
Interface: `SITE_ARTIFACT_MIME = application/vnd.cc.workbench-site+zip`; `snapshotSite(outputRoot, descriptorName): Buffer`, ZIP includes __cc_preview.json `{version:1,entry:string}` and declared files. Descriptor `{entry:string,files:string[]}` uses output-relative paths.

- [x] Write failing tests for actual site with CSS/image/script, old version immutable, traversal/symlink/missing/duplicate files/6 MiB limits.
- [x] Run RED and implement manifest validation with anchored reads and deterministic ZIP.
- [x] Collect `.site.json` as `<name>.site.zip`, preserve standard artifact collection and surface a specific warning on invalid sites.
- [x] Run Node and Bun relevant tests. Root integrates only reviewed patch.

### Task 2: Isolated resource host

Files: apps/desktop/html-preview.ts/.test.ts; src-tauri/src/html_preview.rs and lib.rs; test-shim.ts.
Interface: new `prepare_workbench_site_preview({entry,files:[{path,mime,contentBase64}]}) -> url`; URL first component remains preview ID; each memory entry owns a resource map and entry. Existing prepare HTML stays unchanged.

- [x] Write RED for resource lookup, nested UTF8 paths, query assets, missing/path traversal, total/count limits, per-preview CSP/CORS and release.
- [x] Add exact MIME allowlist and resource-scoped CSP, preserving sandbox and existing response policy for standalone HTML.
- [x] Verify Rust unit checks, TS tests, then native resource script/style/image rendering.

### Task 3: Reader and visible evidence

Files: apps/desktop/src/modules/site-preview.js/.test.ts; workbench.js, workbench-artifact-preview.js/.test.ts; offline vendor script; playwright/workbench-preview.spec.ts.
Interface: `readSiteArchive(bytes) -> {entry, files, source}` validated before host invocation; no zip disk extraction.

- [x] Write RED for bounded archive decode and malformed/unsafe inputs.
- [x] Wire saved-site reader, `网页成品` name, source switch and standard ZIP download; retain existing cleanup and generation checks.
- [x] Real browser verifies linked CSS/image/module imports, nested page navigation, responsive width, error retry, download and preserved old ZIP version.
- [x] Capture user-visible preview; review integrated changes independently; run appropriate cumulative gates and update desktop audit.

Evidence: `apps/desktop/art/cc-artifact-preview/`; browser23 / Rust18 / native WKWebView17 passed. Final cumulative Bun10594 and Node9124 passed, typecheck passed, depcheck0 errors with21 existing warnings. The independent review found no demonstrated high/medium defect. Known pre-existing Node upload-fixture write/close race is recorded in the desktop audit; this batch does not claim it fixed. No installation, deployment, commit or push; the wider ongoing UI review remains active.
