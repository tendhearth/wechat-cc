# CC 桌宠资产:从设计板到成品的生产任务书

日期:2026-09-08。分支 `feat/cc-asset-kit-v1-alpha`(基于 dev 7a063336)。
本文是给下一轮执行者(Codex 或人)的交接书:**设计已定稿,缺的是能放进 manifest 的透明帧。**

## 1. 已定稿的输入(不要再改设计)

| 文件 | 作用 |
| --- | --- |
| `~/Documents/tendhearth/cc-design/CC_MASTER_V1.png`(私有,不进仓库) | 母版:三视图、俯仰角、比例尺寸、表情基准、C 动态语言、使用规范。sha256 见 manifest.reference |
| `~/Documents/tendhearth/cc-design/CC_DESIGN_SHEET_V1.png`(私有,不进仓库) | 形象板:色值/材质、光影分层、带 ? ! z 的表情、尺寸参考、场景适配、Do/Don't。sha256 `9e2ae0e8…355bbf` |
| `apps/desktop/src/assets/pet/cc-v1/manifest.json` | 唯一运行索引,就是购物清单 |
| `apps/desktop/src/assets/pet/cc-v1/README.md` | 契约、替换成品的 7 步流程、fail-soft 规则 |
| `docs/superpowers/specs/2026-09-05-cc-desktop-pet-design.md` | 桌宠状态机 / 桥 / 渲染器设计 |

角色硬约束(manifest.character,validator 强制):`feet=2, eyes=2, arms=0, tails=0, mouth=false, ears=0, c_appendages=1`,Light/Dark 同一几何。

材质:Light 主色 #FFF7E6 / 辅 #FFECD1 / 高光 #FFFFFF / 阴影 #EADDC4,半透软瓷,自发光;Dark 主 #1A1A1A / 辅 #2B2B2B / 高光 #3A3A3A / 眼 #FFFFFF,哑光,**禁止自发光**。

比例(母版第 06 栏):整体高 H,身体 ≈ 0.65H,C ≈ 0.35H,宽 ≈ 1.1H,C 粗 ≈ 38% 身体,眼高 ≈ 12%,眼距 ≈ 28%,脚 ≈ 18%,脚间距 ≈ 40%。

2026-09-09 owner 决定：以 `a6b28e2a` 冻结基础几何、固定相机、两态材质及灯光；第二批从冻结 `.blend` 读取，仅切换已有 C 姿势和眼睛表情。canonical 与转场文件字节不变。新表情继续标为候选，基础正身已获设计验收。

## 2. 运行时契约(不可协商)

- 每帧 **512×512 RGBA PNG(color type 6)**,同一画布,不逐帧裁切、不 offset、不自动缩放。
- 注册点 anchor `[0.5, 0.91796875]` = 脚底 `(256,470)`,baseline 470,safe bbox `[80,28,432,470]`。**Light 的光晕和接触阴影都必须画在 sprite 里并留在 safe bbox 内**,透明窗上没有桌面给它反射。
- Light / Dark 对应帧共用 **同一路径的实体 geometryMask PNG**（canonical，以及按 state / view / expression 对应的 sprite）；复制相同 mask 字节到不同路径也不合规。实体 mask 来自不透明 Dark 几何，包含抗锯齿边缘，不含 glow / rim / contact-shadow。
- 两态成品 alpha 可以因效果不同而不同。逐像素以 0–255 整数校验：`alpha >= mask`；`mask >= 250` 时 `alpha == mask`；`mask == 0` 时 `alpha / 255 <= 0.35`（最大整数 **89**）。效果不得侵蚀实体或改变实心覆盖，全部效果仍须在 safe bbox 内。
- 顶层、每个已声明 state、transition 与 `assets` 条目都必须有 `artStatus`，只允许 `normative-placeholder` / `production-candidate` / `reviewed-production`。候选不代表 owner 已验收；混合交付仍保留顶层占位状态。
- 渲染器是单张 `<img>` 换帧,呼吸/上下浮动由代码做变换,帧本身不要带位移。
- 状态机 13 个 behavior 与 manifest 一一对应;循环态 loop、一次性态回 idle,由状态机管,不改 presence / pet-turn。
- 只改 manifest 的 frames / fps / next / canonical / turnarounds / assets,业务层不认识文件名。

实施记录：步骤 3 已将 `masks/front.png` 替换为不透明 Dark 渲染的实体覆盖；Dark 无外部效果，Light 按本节约束合成 HDR 光晕和接触阴影。

## 3. 要交付的帧(按价值排序)

只做 **一个默认视角**。建议 3/4(两张板子的主视觉都是 3/4,C 的形态最好看);若沿用正面也可以,但要在开工前定死,所有帧同视角。

### 3.1 第一批:两张正身(先交这两张,真机看过再继续)

| 路径 | 内容 |
| --- | --- |
| `canonical/lit/front.png` | Light idle,默认眼 + 默认 C,含光晕与接触阴影 |
| `canonical/unlit/front.png` | Dark idle,同一几何,哑光 |
| `masks/front.png` | 两者共用的实体 mask，含抗锯齿、不含光影效果 |

替换 manifest 的 `forms.*.master`、`states.idle.frames`、`canonical.*`、`turnarounds.*.front`。

### 3.2 第二批:状态表情帧(两态各一套,几何同构)

表情主要靠 **C 的弯法**,其次才是眼睛(母版第 07/08 栏)。形象板上的 ? ! z 符号不画进身体帧,用现有 props(exclamation / thought-bubble)叠加。

| behavior | 表情来源 | C 姿势 | 眼睛 | 备注 |
| --- | --- | --- | --- | --- |
| idle | 默认 | 默认 | 默认竖线 | = canonical |
| blink | — | 默认 | 半闭 / 全闭 两帧 | 序列 idle→half→closed→half→idle,8fps |
| look | — | 默认 | 左偏或右偏 | 一次性,回 idle |
| sleep | 困 | 低落(下垂) | 闭眼 | loop |
| thinking | 思考 | listening(前倾且抬起) | 眯眼横线 | loop |
| working | 专注 | 倾听(前倾) | 默认 | loop;可与 laptop prop 叠 |
| done | 开心 | 开心(上扬) | 弯月 | 一次性 |
| receive | 好奇 / 期待 | 开心 happy(上扬) | 默认略大 | 一次性;叠 envelope prop |
| permission | 疑惑 | 疑惑(打问号) | 默认 | loop;叠 exclamation prop |
| error | 惊讶 | 兴奋 / 惊讶(挺直) | 默认略大 | 一次性 |
| companion | 默认 | 默认 | 默认 | 可与 idle 同帧 |
| drag | 惊讶 | 挺直 | 默认 | 一次性 |
| wake | 默认 | 默认 | 半闭→默认 | 一次性 |

Dark 最少要 idle / blink / working / sleep,其余缺的会回退到 Dark idle;但既然同一模型出图,建议两态全套一起渲。

### 3.3 第三批:转场

`transitions/dark-to-light/000…007.png`,8 帧 8fps,**只插值材料与光晕,几何不动**。
两端点必须与两张 canonical 逐像素一致(validator 校验)。
中间帧可程序化生成：固定同一实体 mask，插值材料并渐入光晕；成品 alpha 可随效果变化，但每帧都必须满足 §2 的实体覆盖与外部 alpha 上限。
Light→Dark 暂用倒放,真机看过再决定要不要单独做。

### 3.4 第四批:道具重画

现有 `apps/desktop/src/assets/pet/props/` 的 7 张(envelope / exclamation / laptop / micro-light / mug / speech-bubble / thought-bubble)是给旧猫化 CC 画的,风格不搭。384×384 RGBA,按新的软瓷 / 哑光质感重画。`sprout.png` 已废弃不用。

### 3.5 最后:文档用资产(不进 runtime)

三视图(正 / 3/4 / 侧 / 背)、俯仰角、48/96/128/256px 尺寸样张。服务设计文档、手机端、宣传图。**状态机从不转身,runtime 不需要侧面和背面。**

## 4. 生产方法建议

**首选:Blender 建真三维模型,脚本化渲染。** 原因:

- CC = 一个球 + 一根弯管 + 两个小球 + 两条眼,建模很快;两张板子本身就是三维渲染
- 两套材质挂同一网格，共用实体 mask；光晕、rim 与接触阴影按各态分别合成，不用抠图对齐
- 固定相机与脚底,所有帧自动落在 (256,470)
- C 的姿势用一根骨骼或形变键控制,表情是改参数
- 转场 = 材质 mix 0→1 渲染 8 帧
- 三视图、尺寸样张、手机端资产同一文件出

可行的做法:用 bpy 写建模 + 材质 + 姿势表 + 批量渲染脚本,`blender -b --python render-cc.py` 一键出全部 PNG。脚本进仓库(`apps/desktop/scripts/`),模型文件 `.blend` 也进仓库作为唯一美术源。

**不建议:图生图逐状态出图。** 每张实体轮廓微妙不同，难以满足两态共用实体 mask;光晕与背景糊在一起抠不干净。图生图适合出设计板(已经出完了),不适合出 sprite。

**退路:现有矢量占位加精细着色。** 能做到「像那么回事」,但软瓷半透和光晕到不了板子的水平。

## 5. 每帧的验收

1. 写 `manifest.assets[path]`:`sha256`、`view`、`expression`、`artStatus: reviewed-production`、`geometryMask`、`visualReview {reviewer, reviewedAt, referenceSha256}`(README 第 4 步)。
2. `node apps/desktop/scripts/validate-cc-asset-kit.mjs` 零 error。
3. `bun --bun vitest run apps/desktop/src/pet src/core/pet-turn.test.ts src/core/companion-presence.test.ts` 全绿(素材数量 / 占位源断言是 alpha 快照,替换时改测试为新成品验证,不许只删断言)。
4. 人工逐帧看:两脚、单 C、无嘴耳手尾、两态对齐、透明边缘无白边、光晕在 bbox 内、脚底落点。
5. pet-lab(`/pet-lab.html` 与 `?reduced`)过一遍 13 个 behavior + 转场 + 坏帧回退。
6. 真 Tauri 透明窗看 48 / 96 / 128 / 256px,深浅两种桌面背景。
7. 所有必需帧审完后 manifest 顶层 `artStatus` 才改 `reviewed-production`。
8. **不要再跑 `build-cc-asset-kit.mjs`**,它会用占位覆盖手改的 manifest。

## 6. 已知欠项与决定点

- 默认视角正面还是 3/4:开工前定。
- 母版与形象板 PNG 已在分支里,推 origin 即进公开仓库:owner 决定。
- Light→Dark 是否单独做转场:真机看过再定。
- 拆层 rig(身体 / C / 眼睛三层代码合成)是 v2 路线,要改渲染器契约,第一批帧验完再议。
