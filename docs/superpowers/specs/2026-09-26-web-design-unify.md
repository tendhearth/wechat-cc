# 手机端网页界面统一设计风格

- 日期:2026-09-26
- 状态:owner 用 `/loop 统一设计风格,不要中途打扰我` 授权自主执行;以下取舍均为执行者裁定(不中途确认),owner 回来后审。
- 范围:主人会在手机上看到的所有网页 —— `/m`(此刻 / 一起做 / 回忆 / CC 眼中的你)、微信 `/set` 设置页、`/m` 引导页、过期页、中继壳页 `relay/pset.html`。**不含桌面 app**(另一套技术栈;owner 定过桌面尽量不加东西)。

## 问题

同时存在两套视觉:

| | 旧「暖棕手绘」 | 新「安静纸色」 |
|---|---|---|
| 纸 | `#f5ead8` | `#f9f7f1` |
| 墨 | `#5a3f2d` | `#483f35` |
| 次要字 | `#8b5e3c` | `#7e7365` |
| 强调 | `#b0563a`(锈红) | `#735b3e`(暖棕)+ 暖橙点缀 `#b0763a` / `#e8a25a` |
| 线 | `rgba(89,63,44,.25)` | `#e5dfd3` |
| 圆角 | 不规则手绘(`14px 18px 12px 20px`) | 规则 10 / 14 / 16 / 999 |

`/m` 目前靠 `presence.css` 在最后覆盖 `:root`,底层仍是旧值与手绘圆角;`/set`、引导页、过期页、壳页全是旧值。

## 裁定

1. **新「安静纸色」为唯一基准**,与 `cc-design/CC_DESIGN_SHEET_V1.png`(温柔·安静·陪伴,纸色、柔光、手写点缀)和「此刻」第二版一致。
2. **单一色板来源** `apps/mobile/src/tokens.css`:

```css
:root{
  --paper:#f9f7f1; --card:#fffefa; --ink:#483f35; --soft:#7e7365; --faint:#9a8f82;
  --line:#e5dfd3; --line-soft:#efe9de;
  --accent:#735b3e; --warm:#b0763a; --warm-line:#efd9bd; --dot:#e8a25a; --glow:rgba(255,236,205,.95);
  --danger:#a8553d;
  --r-s:10px; --r-m:14px; --r-l:16px; --r-pill:999px;
  --font:system-ui,-apple-system,"PingFang SC",sans-serif;
  --hand:"Kaiti SC","STKaiti",serif;
}
```

   - `/m`:`phone.html` 第一段样式包含它;删掉 `phone.html` 与 `presence.css` 各自的 `:root`。
   - `/set`、过期页:daemon 不能 import `apps/mobile` —— 生成物 `mobile-page.generated.json` 多带一份 `tokens`,daemon 侧从 `mobile-page.ts` 导出 `MOBILE_TOKENS_CSS` 给 `settings-panel-html.ts` 内联。
   - 引导页 `bootstrap.html`:包含 `{{>tokens.css}}`。
   - 壳页 `relay/pset.html`(中继静态文件,单独部署):手工同步色值,**测试**断言它用到的颜色都在 tokens 里。
3. **规则化形状**:按钮 / 输入 `--r-s`;卡片 `--r-m`;大块便签 `--r-l`;胶囊 `--r-pill`。去掉不规则手绘圆角 —— 「手绘感」只留给手写体(`--hand`)的一两句话,不放在边框上。
4. **层次**:标题 500 字重、字距略紧;次要信息 `--soft` / `--faint`;强调色只用于可点的主要动作与少量状态(期限、新点)。危险 / 错误用 `--danger`,不再用锈红当主强调。
5. **不引入新依赖、不改结构**:只换样式与颜色引用;任何 DOM id / 脚本行为不变(现有测试保护)。

## 验证

- 漂移测试:`/m` 生成物、`/set` 页、引导页、过期页中**不再出现**旧四色 `#f5ead8 #5a3f2d #8b5e3c #b0563a`;`relay/pset.html` 的每个 `#rrggbb` 都在 tokens 里。
- 512KB 帧、同步、行首括号等现有测试照旧。
- 视觉:无头浏览器在 390px 宽截 `/m` 四个 pane、`/set`、引导页、过期页,执行者逐张看(对比改前截图),截图放 scratchpad 不进仓库。
- 标准回路全绿;最后一轮全分支评审。
- 不推送、不部署:owner 回来后决定(部署会断开桌面 app;壳页要手动上中继)。
