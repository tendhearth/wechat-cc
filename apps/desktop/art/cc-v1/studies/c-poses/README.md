# 原定八种 C 姿态 · 双态研究

[暖纸对照](guide-paper.png) · [灰板对照](guide-slate.png)

默认、倾听、开心、疑惑、思考、低落、生气、兴奋，来自已经冻结的同一个模型形变键。两态使用相同几何和实体遮罩，眼睛保持原定的正常开眼；没有另画嘴、耳、手或尾。这是设计研究，尚未新增对应的运行时情绪，也不表示 CC 推断了主人的心情。

每种姿态提供 512×512 的 Light / Dark RGBA PNG 与一张实体 mask。默认姿态直接保留原 canonical 字节；其余七种姿态从原场景重新渲染。Light 保留柔软瓷色与克制暖晕，Dark 保持炭黑哑光、白眼和无外部雾。脚底仍在 y=470，身体与双脚的实体轮廓保持不动。

全部标为 `production-candidate`。`poses.json` 记录源模型、渲染器、几何辅助和研究脚本摘要，以及每个输出的 SHA-256。构图、对应遮罩、alpha、边界、身体与脚底已校验；两张指南经过实施者与独立视觉检查。这不代替主人美术验收。

从仓库根目录复现：先完成主动作批次，保留其 digest checkpoint；研究输出目录必须不存在，已有稿件应先移到自己的备份目录。

```sh
nice -n 20 /Applications/Blender.app/Contents/MacOS/Blender \
  -b --python-exit-code 1 --python apps/desktop/scripts/render-cc-pose-studies.py
CC_SHARP_MODULE=/absolute/path/to/sharp \
  node apps/desktop/scripts/build-cc-pose-guide.mjs
```

研究脚本只加载已经校验、无需重渲的主批次样本来取得冻结场景，然后把所有附加渲染重定向到研究目录与临时原始文件目录。前后核对模型、相机、canonical、转场、主 manifest 与主 checkpoint 的摘要；它不会登记或替换正式动作。
