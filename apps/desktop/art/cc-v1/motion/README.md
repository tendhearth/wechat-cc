# CC 动作审阅

这页并排审阅 Light CC「在身边」与 Dark CC「暂时没连上」。使用同一张暖纸、同一个动作进度和同一个显示尺寸；灰板只用于对比检查，不代表产品主题。所有新增素材保持 `production-candidate`，自动检查不代替主人美术验收。

2026-10-29 的当前候选包含 10 组动作、132 对样本、40 张完整联系表。直接打开[离线分享预览](samples/index.html)可看实际双态节奏；[八种原定 C 姿态研究](../studies/c-poses/README.md)单独保留，不新增运行时情绪。功能分支、复现结果、长测与原生检查边界见[本轮交付记录](../../../../../docs/superpowers/reports/2026-10-29-cc-motion-verification.md)。

从仓库根目录启动独立静态预览（不连接 daemon，不启动或安装桌面 app）：

```sh
python3 -m http.server 4197 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4197/apps/desktop/art/cc-v1/motion/index.html`。需要先由动作渲染流程生成同目录的 `catalog.json`；没有目录、格式错误或任何一态帧缺失时，页面给出错误并停止预览。切换到完整的动作可以继续检查。每个动作先解码全部双态帧，再显示成对画面。

默认停在目录指定的 poster 帧。点击「播放」按目录 fps 前进。循环动作重复；一次性动作保留末帧，只在点击「重播」后再次播放。切换动作、逐帧、拖动进度、隐藏页面或开启减少动态均停止播放。系统减少动态始终优先，仍可手动逐帧检查。按钮、选择框和进度条可直接用键盘操作。窄屏的 256px 双态可横向滚动，不裁切或缩小图像。

## 目录与路径

`catalog.mjs` 同时用于浏览器和离线生成器。目录 schema 为 1，必须有 `lit` / `unlit` 双态、相同数量的对应帧、每帧的共享 mask 引用、正 fps、布尔 loop、有效 posterIndex、来源 SHA-256 与候选状态。

本目录下的 `catalog.json` 使用 `baseUrl: '../../../src/assets/pet/cc-v1/'`。所有帧和 mask 都是 kit 内 motion / canonical / masks 目录下的相对 PNG 路径，不能包含 URL、查询参数、编码或父目录跳转。浏览器只请求同源的 CC kit；生成器额外检查真实文件路径，拒绝越出 kit 的符号链接。

## 实际帧联系表

```sh
CC_SHARP_MODULE=/absolute/path/to/sharp \
  node apps/desktop/scripts/build-cc-motion-review.mjs
```

也可依次传入目录 JSON、资产 kit 与输出目录。`sharp` 使用已有安装或 `CC_SHARP_MODULE`，不改依赖锁文件。默认输出到本目录的 `contact-sheets/`：每个动作在 48/96/128/256 px 下，按暖纸 Light、暖纸 Dark、灰板 Light、灰板 Dark 排列，包含所有实际帧，不抽帧。每格标帧号。`summary.json` 记录目录摘要、来源、成对样本数、帧引用数、实际 PNG 尺寸、字节数、SHA-256，以及每张联系表的输出尺寸和渲染帧数。全部输入验证通过后才生成输出。

## 可分享的双态动作样片

已完成目录登记后，可将实际 PNG 生成可直接打开、分享的双态样片；不启动 daemon、桌面 app 或本地服务器：

```sh
CC_SHARP_MODULE=/absolute/path/to/sharp \
  node apps/desktop/scripts/build-cc-motion-samples.mjs \
  apps/desktop/art/cc-v1/motion/catalog.json \
  apps/desktop/src/assets/pet/cc-v1 \
  /absolute/path/to/new-or-empty-samples
```

输出目录须为新目录或空目录，不能与源 kit 重叠，也不能包含源目录 JSON。生成器先检查所有路径、双态对应关系、时序以及全部帧和 mask 的完整解码，再写出文件；源目录与素材保持只读。无需安装依赖或修改锁文件，已有 Sharp 即可；不依赖 ffmpeg 的可选 WebP 编码器。

每个动作输出 `<id>.webp` 和 `<id>-poster.png`，两态同时出现在暖纸上、各占相同的 256px 方形区域（调用 `buildMotionSamples` 时可选 `displaySize: 128 | 256 | 512`）。不添加 Dark CC 光晕，不改变透明素材比例，不插帧。`index.png` 按目录顺序汇集每个动作的 poster；`summary.json` 记录候选状态、目录与源摘要、尺寸、帧数、目录 fps、循环方式、精确目录时长及 WebP 延时。

直接打开 `index.html` 即可预览。HTML 内嵌样片 PNG、样式和播放逻辑，可单独分享；下载 WebP 的相对链接需要同目录的 WebP 文件。默认显示 poster，点击 Play 后按目录 fps 播放，两态始终使用相同样本。循环动作重复，一次性动作播放一次后保持末帧，可点击 Replay 重播；隐藏页面会暂停。所有画面标为 `production-candidate`，是美术样片，不声称实时连接或工作状态。

WebP 格式只保存整数毫秒时间戳。生成器对累计帧边界取最近毫秒，因此每个边界误差最多 0.5ms；保留全部样本，包括连续相同的帧，不重新采样。HTML 使用原始目录 fps。WebP 写入循环次数，但各查看器的循环策略可能不同，一次性动作的末帧保持以 HTML 预览为准。

```sh
CC_SHARP_MODULE=/absolute/path/to/sharp \
  bun --bun vitest run apps/desktop/scripts/build-cc-motion-samples.test.mjs --maxWorkers=2
# 同时提供 CC_PLAYWRIGHT_MODULE 可运行独立 file:// 预览的真实浏览器播放检查。
# 需要时以 CC_CHROMIUM_EXECUTABLE_PATH 指向已有 Chromium，无需下载。
```

## 审阅页验证

```sh
CC_SHARP_MODULE=/absolute/path/to/sharp \
  bun --bun vitest run apps/desktop/scripts/build-cc-motion-review.test.mjs --maxWorkers=1
CC_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node --test apps/desktop/scripts/cc-motion-review.browser-check.mjs
```

目录与播放语义的三项纯测试始终运行；四项实际栅格集成测试仅在提供 `CC_SHARP_MODULE` 时运行。浏览器检查脚本独立于 Vitest 默认收集，需显式运行。

浏览器测试只启动一个无头 Chromium，在独立端口 4197 注入明确的测试目录，引用仓库现有 canonical PNG。重复静帧只验证控制、加载与失效行为，不证明新动作的视觉质量。截图默认写到 `/tmp/cc-motion-review-fixture.png`，同目录另存灰板 48px、减少动态与坏帧截图；可用 `CC_MOTION_SCREENSHOT` 指定 PNG 路径。已有浏览器安装与 Playwright 版本不匹配时，可用 `CC_CHROMIUM_EXECUTABLE_PATH` 指向已安装的 Chromium，无需下载新浏览器。正式新动作仍需使用实际生成目录另行逐帧审阅。
