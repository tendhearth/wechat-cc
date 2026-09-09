# CC Asset Kit v1.0-alpha 验证记录

验证日期：2026-09-08。代码基于 `dev` 的 `7a0633368f1569b22f2b5637051c1154dfd73be0`；实施期间再次查询远端，仍为该 commit。独立工作 clone，未覆盖已有工作；没有修改 daemon/presence/pet-turn/state machine。

## 真实执行结果

工作目录为仓库根目录。此云端 Node 不在默认 PATH，实际使用 `$CODEX_PRIMARY_RUNTIME_NODE`；等价于本机的 `node`。Vitest 4.1.4、TypeScript 6.0.3 和 Node 类型安装在独立测试工具目录，经忽略的 `node_modules` 链接使用，没有改项目依赖或 lockfile。

```sh
"$CODEX_PRIMARY_RUNTIME_NODE" apps/desktop/scripts/build-cc-asset-kit.mjs
"$CODEX_PRIMARY_RUNTIME_NODE" apps/desktop/scripts/validate-cc-asset-kit.mjs
"$CODEX_PRIMARY_RUNTIME_NODE" node_modules/vitest/vitest.mjs run apps/desktop/src/pet src/core/pet-turn.test.ts src/core/companion-presence.test.ts
```

- 生成：37 个 SVG 资产，全部 `normative-placeholder`。
- 发布校验：`errors: []`；两条预期 warning 明确说明“位图解剖仍需视觉审核”和“最终美术未完成”。
- 定向回归：**14 个测试文件、138 个测试通过，0 失败**。覆盖旧扁平 manifest 兼容、嵌套 manifest、新包、resolver、renderer、状态机、桥、权限卡、presence 和 pet-turn 纯函数。
- 新增检查：硬约束每个字段、两态 geometryId/发光标记、所有引用与摘要、真实矢量几何/双脚/双眼、坏路径、空帧、缺状态、全段转场缺失、坏 master、重复坏帧、manifest 404/坏 JSON/违规元数据、真实 intent 保留与销毁后计时器清理。
- 发布校验比运行时严格：必需状态经过 normalize 后仍必须可用；角色帧缺 `assets` 元数据必须报错。运行时缺图继续降级。
- PNG 替换回归：合成测试审查记录、共享 PNG mask、PNG canonical 替换可通过；不同比特的 mask 必须被检测。PNG fixture 是本版占位的栅格化，不是正式美术，也不意味着机器验证了它的解剖。

定向严格类型检查：

```sh
"$CODEX_PRIMARY_RUNTIME_NODE" node_modules/typescript/bin/tsc --ignoreConfig --noEmit --allowJs --checkJs --strict --skipLibCheck --noUncheckedIndexedAccess --target esnext --module esnext --moduleResolution bundler --lib esnext,dom --types node apps/desktop/src/pet/assets/cc-contract.js apps/desktop/src/pet/pet.js apps/desktop/src/pet/assets/cc-asset-kit.test.ts apps/desktop/src/pet/pet.test.ts
```

结果：exit 0。它同时检查新包共享模块、loader、resolver、renderer 及导入的 validator；不是整个仓库的 typecheck。

离线栅格检查：

```sh
CC_SHARP_MODULE="$CODEX_PRIMARY_RUNTIME_NODE_MODULES/sharp" "$CODEX_PRIMARY_RUNTIME_NODE" apps/desktop/scripts/verify-cc-placeholder-raster.mjs /tmp/cc-kit-qa
```

本机可将 `CC_SHARP_MODULE` 指向已安装的 sharp 目录；若本机模块解析能找到 sharp，则直接 `node apps/desktop/scripts/verify-cc-placeholder-raster.mjs /tmp/cc-kit-qa`。sharp 仅用于可选离线 QA，不是桌宠新增运行依赖。

结果：37/37 为 512×512 且非空 alpha 在 safe bbox 内；4/4 组 canonical Light/Dark alpha 相同；2/2 转场端点与对应 canonical RGBA 逐像素一致。眼睛中心实际取样：Dark `[255,247,230,255]`，Light `[21,20,18,255]`。已查看全部 37 张栅格总览，检查两脚、单 C、无手尾嘴耳、背面遮挡与未裁切边缘。曾在此步骤发现 CSS 自定义变量导致 Dark 眼睛被某些栅格器渲染成黑色，已改为 SVG `currentColor` 并重新验证。

`git diff --check`：通过。独立代码审查发现的必需帧漏检、缺素材元数据、PNG mask 比较与递归 mask 要求均已处理并补回归。

## 未通过或未能运行的检查

| 检查 | 实际状态与原因 |
| --- | --- |
| 仓库全量 `tsc --noEmit` | 执行后 exit 2：`TS2688 Cannot find type definition file for 'bun'`。本云端未安装仓库完整 Bun/SDK 依赖，不能声称全量类型检查通过 |
| 仓库全量测试 | 未运行；仅运行上述 14 个相关测试文件，不能外推全仓绿灯 |
| pet-lab 浏览器交互 | 启动静态 HTTP 服务后，云浏览器访问 `http://127.0.0.1:4174/pet-lab.html?reduced` 被环境阻止，返回 `net::ERR_BLOCKED_BY_CLIENT`。未将离线栅格化或注入 DOM 单测冒充浏览器 E2E |
| Tauri 构建与原生透明窗 | 未运行；当前不是用户的 macOS/Windows 桌面，无真实窗口拖动/系统缩放/权限联动验证环境 |
| 最终美术验收 | 未通过“生产美术完成”门槛：本包明确是规范占位，仍需 README 中的生产资产与人工审批 |
| 远端分支 / 草稿 PR | 本地已提交。Git 命令行 push 因缺少 HTTPS 凭据失败；改用已连接 GitHub 后，自动审批拒绝上传母版原图到公开仓库，认为尚无针对该原图公开发布的明确授权。没有创建远端分支或 PR，也没有绕过该拒绝；完整成果保留在本地分支，待用户明确确认公开原图后继续 |

## 人工复验入口

本机启动现有桌面开发服务，打开 `/pet-lab.html` 和 `/pet-lab.html?reduced`。界面显式提示 alpha 规范占位。验证 unlit working → lit transition → thinking/working → done → resting；反向淡入淡出；permission/drag；news envelope 与 badge；随机 blink/look 及 reduced motion；删除工作帧或 master 时仍显示同形态规范占位。

再在真实 Tauri 透明窗核对 48/96/128/256px、深浅背景与缩放。所有真实活动/完成/权限事实必须仍来自已有桥与 daemon，不从动作表现猜测业务状态。
