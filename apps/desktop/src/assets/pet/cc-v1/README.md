# CC Asset Kit v1.0-alpha

## 设计板不在仓库里

母版 `CC_MASTER_V1.png` 与形象板 `CC_DESIGN_SHEET_V1.png` 是品牌资产,**不进公开仓库**,私有目录 `~/Documents/tendhearth/cc-design/`。
manifest 的 `reference` / `designSheets` 只保留 sha256 作来源凭证;validator 在文件存在时校验摘要,不存在时记 `reference_absent` warning 跳过。
需要对照设计做审图时,把两张图临时拷进 `cc-v1/`(.gitignore 已挡住,不会被提交)。
本目录下全部资产的许可见仓库根 `ASSETS-LICENSE.md`,不随代码的 MIT 走。

## 2026-09-09：基础设计冻结，第二批表情候选

Owner 已验收 `a6b28e2a` 的基础几何、相机、Light/Dark 材质与灯光；canonical 正身标为 `reviewed-production`。第二批以该 `.blend` 为只读源，用 `render-cc.py -- --expressions-only` 生成；不覆盖源文件、正身、blink/sleep 或八帧转场。

两态各有完整 13 个行为。thinking / working / done / receive / permission / error / look / drag 已有独立 PNG，companion 直接引用 canonical，wake 使用半闭→默认。新表情均为 `production-candidate`，不再用 rest 冒充表演。未完成的 turnaround 仍保留占位，七张道具已替换为 Blender 候选，整个包仍为 `normative-placeholder`。

thinking 已改用前倾抬起的 listening 姿势与 mask；旧 thinking mask 仅留作历史未引用资产。

同一 C 姿势共用一个实体 mask：默认 `front`、睡觉 `sleep`，新增 `thinking/listening/happy/confused/excited`；done/receive 共用 happy，error/drag 共用 excited，look 复用 front。眼睛不改变身体轮廓。

- 当前表情对照：`apps/desktop/art/cc-v1/expressions-{lit,unlit}-review.png`。
- 冻结文件摘要：`apps/desktop/art/cc-v1/design-freeze.json`。
- 验证记录：`apps/desktop/art/cc-v1/VALIDATION.md`。
- 原生 `revision-v3` 截图为历史材质，不能代表当前字节；真实桌面透窗目测仍待 owner 完成。

## 七张道具候选

`../props/` 下七个既有路径已换成 384×384 透明 Blender 渲染，软瓷/哑光材质，至少 12px 透明边距。感叹号使用饱和暖橙色；micro-light 由 HDR Fog Glow 生成柔和金色光晕。metadata 标注 `kind: prop` 和候选状态，独立校验尺寸与摘要，不使用角色的实体 mask 契约。sprout 不在 manifest 或当前 lab 中；旧文件保留作历史兼容。

## 当前实体 mask 与美术状态契约

Light / Dark 对应 canonical 与按 state / view / expression 对应的 PNG sprite 必须引用 **同一个 `geometryMask` 路径**；相同字节的另一个文件也不算共用。mask 为不透明 Dark 几何覆盖（含抗锯齿），不含 glow / rim / contact-shadow；光影可让两态成品 alpha 不同。

逐像素按 0–255 校验：`alpha >= mask`；`mask >= 250` 时 `alpha == mask`；`mask == 0` 时 `alpha / 255 <= 0.35`，即 alpha 最大 **89**。所有效果仍须在 safe bbox 内。数值校验不能证明 mask 的几何来源，仍需审查渲染来源和视觉结果。

顶层、每个声明的 state / transition、每个 `assets` 条目的 `artStatus` 必填，仅允许 `normative-placeholder`、`production-candidate`、`reviewed-production`。`production-candidate` 表示待验收候选，不能代替 owner 确认。

## 历史：初始 alpha 包

以下数量、全部占位与材料描述是历史记录，由上面的第一批记录和当前契约更新。

**可运行的规范占位资产包，不是最终美术交付。** 正式母版设计板已取得并核对，原样保存在 `CC_MASTER_V1.png`；它仅供设计参考，绝不作为透明 sprite 加载。所有运行帧均明确标注 `normative-placeholder`，没有把新画的矢量占位声称为用户确认的美术。

## 基线与契约审查

- 仓库：`tendhearth/wechat-cc`，远端 `dev` commit **`7a0633368f1569b22f2b5637051c1154dfd73be0`**。本轮在全新 clone 的 `feat/cc-asset-kit-v1-alpha` 分支修改，未覆盖已有工作。
- 已读取 `docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md`、`2026-09-03-companion-presence-design.md`、`src/core/pet-turn.ts`，并核对 loader / resolver / renderer / state machine / bridge / 测试。
- 母版来源：对话 `6a9d19cc-8a14-83ea-8af8-330402ca67db`，附件 `CC Master v1 Character Design Sheet.png`。`manifest.reference.sha256` 记录原始文件摘要。设计板个别表情小图出现疑似嘴线、C 形变等，不作为运行帧；本轮用户的最新无嘴、同构硬约束优先。
- 旧 spec 与 `../README.md` 中耳朵、嘴、双叶芽、猫化参考已失效。旧猫化位图包已从正式包删掉（2026-09-10），其扁平 manifest 只作为 loader 历史兼容的测试夹具保留在 `src/pet/assets/fixtures/legacy-v1-manifest.json`。
- 业务 form 继续使用 **`lit` = Light、`unlit` = Dark**；state machine 使用 `behavior`，对外仍是 `setState()`。不新增第二套 Light/Dark 业务枚举。
- manifest 使用既有 `forms.<form>.states.<behavior>`、`canonical.<form>`、`transitions`、`props` 形状。业务只消费形态/状态，道具仍独立；具体帧路径只存在于 manifest 和资产工具。
- 遵循真实注册点：**512×512，anchor `[0.5, 0.91796875]` = `(256,470)`，baseline 470，safe bbox `[80,28,432,470]`**。没有盲用历史建议的 y466。全帧同 canvas；禁止逐帧 bbox 裁切、offset、自动缩放修图。renderer 既有呼吸以同一 anchor 为变换原点。
- presence、pet-turn、权限、完成事件、优先级和状态机均保持现有语义。没有为缺图假造活动或完成事件。

## 目录与首版覆盖

| 位置 | 内容 |
| --- | --- |
| `CC_MASTER_V1.png` | 原始母版设计板，仅参考 |
| `manifest.json` | 唯一运行索引、画布/解剖约束、来源、素材状态与 SHA-256 |
| `placeholder.js` | 共享矢量几何与材料定义；也是全包失败时的内联应急帧来源 |
| `canonical/{lit,unlit}/` | front、three-quarter、side、back，共 8 张规范占位 |
| `sprites/{lit,unlit}/` | 状态帧，包括半闭/闭眼眨眼帧，共 17 张规范占位 |
| `transitions/dark-to-light/` | 8 张逐帧材料插值；同一几何，无双角色叠影 |
| `masks/` | 4 张共用剪影 mask，无眼睛/光影层 |

| 形态 | 状态 | 交付程度 |
| --- | --- | --- |
| Light / lit | idle, blink, look, receive, thinking, working, done, sleep, permission, error | 全部可解析、可播放；blink 有 5 帧序列，look 改眼睛朝向，sleep 闭眼，其余是显式静态规范占位 |
| Light / lit | companion, drag, wake | 保留旧业务词表，附静态规范占位 |
| Dark / unlit | idle, blink, working, sleep | 可播放的最小生存集；working 是显式静态规范占位 |
| Dark / unlit | 其余行为 | 画面回退到 Dark idle，逻辑仍保留请求的行为 |
| Dark → Light | `unlit-to-lit` | 8 fps / 8 帧，占位材料转场；首末材料与 canonical 一致 |
| Light → Dark | `lit-to-unlit` | 缺正式帧，继续既有 240 ms 淡出 + 240 ms 淡入；不倒放 |

37 张 SVG 直接由现有 `<img>` renderer 消费。没有按状态复制旧违规位图。静态占位不等于完成了 thinking / working / done 等表演设计。相同姿态是公开记录的美术欠项，不改变状态语义。

角色定义严格为 `feet=2, eyes=2, arms=0, tails=0, mouth=false, ears=0, c_appendages=1`。两形态每个视角共用完全相同的 body/C/feet/eyes 坐标和轮廓；闭眼仍是两只眼睛，背视图眼睛遮挡而不是在后脑画一张脸。侧视图仅为工程示意，仍保留两脚；它不是经美术确认的真实三维转面。

Light 使用暖象牙渐变、黑眼睛和极轻 self-light；Dark 使用炭黑渐变、暖白眼睛，self-light opacity 严格为 0。软瓷半透、磨砂质感和环境反射尚未达到母版品质。SVG 内部有 `geometry`（base）、`self-light`、`rim`、`contact-shadow` 分组；renderer 仍将它作为一张图播放。`rim` 暂为空，动态环境光和独立图层合成列 TODO，不增加不兼容的 renderer 契约。

沿用独立的 envelope/badge、micro-light、laptop、气泡、感叹号和 mug 道具。未把 sprout 纳入本包，避免视觉上长出双叶头饰；业务道具词表仍兼容旧包。状态 sprite 本身没有手或嵌入笔记本，业务桥的既有 props 决策不在这轮改变。

## 校验与 fail-soft

运行时 `normalizeManifest` 对声明为 `kitId: cc-v1` 的包检查解剖元数据、同构标记及 geometryId、两种发光声明。相互矛盾的角色声明使该包加载失败并进入内联安全占位。元数据合法但状态缺失/空帧，仍按既有 resolver 回退。

坏帧会被摘除；整段无帧时回到同形态 idle → master。master 也坏时，换成同形态 `data:image/svg+xml` 规范占位；该帧无需额外网络请求，现有 Tauri CSP 已允许 `img-src data:`。整个 manifest 404、无效 JSON 或无效角色声明时，同样保留实际 `applyIntent`、状态/形态变化与计时器清理，显示占位和资产提示。应急包没有外部道具图；逻辑上的 props/badge 仍保留。

**机器校验不等于视觉校验。** 元数据说 feet=2 不能证明任意 PNG 没有第三只脚。现有矢量占位可对照受控源，检查实际 geometry 字符串、部件数、SHA 和 Light/Dark 对应几何。栅格化后另测尺寸、alpha safe bbox 与眼睛取色；这些检查仍不能替代逐帧人工视觉审查。PNG 的 geometryMask、reviewer、reviewedAt 是来源/审查记录，不能自动证明图片与 mask 相符。

从仓库根目录执行：

```sh
node apps/desktop/scripts/validate-cc-asset-kit.mjs
bun --bun vitest run apps/desktop/src/pet src/core/pet-turn.test.ts src/core/companion-presence.test.ts
```

有 Node 与已安装的 Vitest 时，也可用 `node node_modules/vitest/vitest.mjs run ...` 执行同一套定向测试。实际本轮命令、结果、受阻检查见 `VALIDATION.md`。

## TODO：仍缺的正式美术

1. 经人工确认的 Light/Dark 同构四视图透明成品，以及真实侧/背面遮挡规范。
2. 所有状态的最终高质量 sprite（包含本版已有占位眨眼/睡眠/张望）；thinking/working/receive/done/permission/error 等专属动作表演与连续帧。
3. Dark→Light 最终光影转场及 Light→Dark 正式转场；保持首末注册点与 canonical 连续。
4. 软瓷/磨砂半透、intrinsic glow、环境 rim、contact-shadow 的生产分层与合成规范。Dark 禁止自发光。
5. 48/96/128/256px、深/浅背景、真实 Tauri 窗口上的视觉验收，以及现有道具与新身形的美术适配。

## 替换最终高质量 sprite

1. 保留母版原图与来源摘要。以母版和最新硬约束建同一几何/rig，再分别渲染 Light/Dark 材料；不得独立生成两只不一致的角色。
2. 导出透明 **512×512 RGBA PNG（color type 6）**，统一 `(256,470)` anchor、baseline470、safe bbox。不要在运行时修尺寸或落脚点。将同视角/状态共用的几何 mask 放到 `masks/`，记录来源。
3. 将成品放到 `sprites/` 或 `canonical/` 新文件名，只改 `manifest.forms[form].states[state].frames`、fps/loop/next 和相应 `canonical`/`turnarounds` 引用。持续状态保持 loop；一次性状态保持非 loop，回落目标由状态机管理。新增转场放到 `transitions`，不要改 presence/pet-turn 来匹配美术。
4. 为每个替换帧写 `assets[path]`：`sha256`（实际文件摘要）、`view`、`expression`、`artStatus: reviewed-production`、`geometryMask`（包内路径）、`visualReview: { reviewer, reviewedAt, referenceSha256 }`。把 mask 本身也纳入 `assets` 与摘要校验。对应 Light/Dark PNG 必须引用同一路径的实体 mask，成品 alpha 按上面的覆盖规则校验；人工验证 mask 来自不透明 Dark 几何且不含效果。待验收帧先标 `production-candidate`，确认后才标 `reviewed-production`。混合交付期间顶层 `artStatus` 仍保持 `normative-placeholder`，直到所有必须资产都审核完成才改为 `reviewed-production`。
5. 更新 `forms.*.geometryId` 时两态必须一起变更。保留 `character` 硬约束。删掉已替换帧的专属 TODO，只在真实验收后记录美术完成。
6. 跑 validator 与定向测试（素材数量/占位源断言是 alpha 快照，替换时应改为新成品验证，不可只删除测试以求通过）。逐帧人工审查部件、Light/Dark 对齐、透明边缘、C 比例、落脚点及闭眼/遮挡；在 pet-lab 和 Tauri 验证请求状态、坏图回退及 reduced motion。
7. **不要再运行 `build-cc-asset-kit.mjs` 覆盖手工修改的 manifest**：该命令仅重建本版规范占位。生产包整包升级时保留 `placeholder.js`，以便所有外部资产失败时仍有安全占位。

最终美术可以完全替换而无需业务层认识新文件名。本 alpha 的同构结论仅覆盖本次受控矢量源及实际检查过的帧，不延伸到未来任意位图。
