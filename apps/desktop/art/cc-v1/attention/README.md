# 有依据的眼神与文字回应候选

2026-11-10，第二批。沿用冻结三分之四视角、材质、灯光和 `(256,470)` 脚底；不修改 canonical、转场或旧动作。私有母版仅只读参考，不复制进仓库。

`render-cc-attention.py` 只加载旧渲染器的定义和冻结场景部分，在临时 kit 渲染，拒绝覆盖任何不同字节的已有目标；旧渲染器字节保持不变，避免破坏旧素材来源证明。`recipes.json` 使用现有 performance rig 的眼球表面定位和身体形变，新增独立 `attention/` 命名空间。左右各移动眼神 `.07`，抬眼 `.12`，低头 `-.04`；说话候选只含两次小幅躯干/眼神变化，脚部控制全部为零，无嘴、无口型。已有眨眼直接复用。

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python apps/desktop/scripts/render-cc-attention.py -- --plan apps/desktop/art/cc-v1/attention/recipes.json --samples 96 --threads 2
node apps/desktop/scripts/validate-cc-asset-kit.mjs
```

新条目手工加入 manifest；`render-progress.json` 记录冻结源、渲染器、参数、seed 与每张 PNG 的摘要。每对素材共用同一路径的实体 mask，来自不透明 Dark 的抗锯齿覆盖，不含光晕或接触阴影。新 state 不增加业务状态，只供真实信号的表现层选择；全部保留 `production-candidate`。

实施者已用 PIL 将 canonical 与全部新关键帧在暖纸上并排检查，覆盖双态 256/96/48px：身体和 C 的比例、双脚落点、轮廓光与材质一致；左右眼神在 48px 很轻微，96px 可辨；抬眼最清楚；低头克制；躯干候选没有滑脚和额外肢体。此为实际美术自审，不等于主人美术验收。联系表、关键帧与 UI 回执保存在本任务 scratch `cc-alive-2-shots/`，不将私有设计板或报告图片带入仓库。
