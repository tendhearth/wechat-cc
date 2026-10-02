# Tendhearth 设计统一(桌面 + 手机)Implementation Plan(plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面 app 与手机 app 换成同一套设计语言 —— 一张不变色的暖纸、本地打包的衬线字、一个深绿强调色、CC 是唯一插画且明暗来自真实信号 —— 并按认可稿重排两端的「此刻」,功能一样不少。

**Architecture:** 新包 `packages/design-tokens` 是颜色 / 字号 / 形状的唯一出处:手机直接 import,桌面由脚本生成 `tokens.css`,守卫测试钉住两边一致。字体用 fonttools 一次性裁好入库(手机 TTF、桌面 woff2)。CC 明暗是两个纯函数(手机看隧道连接,桌面看 presence 轮询)。手机先做(token → 去深色 → 明暗 → 此刻 → 其余页 → 截图),桌面后做(token / 字 → 此刻纯函数 → 此刻重排 → 侧栏 → 工作台与对话 → 其余面板 → 截图);每一步都有守卫测试或单测,结构变动处同步改 Maestro / Playwright。

**Tech Stack:** TypeScript、Expo SDK 57 / Expo Router / React Native 0.86 / expo-font、vanilla JS + CSS(Tauri 2 webview)、vitest(根目录 bun + node 两遍;`apps/app` 自己一套)、Playwright(desktop-e2e,端口 4176)、Maestro、fonttools(只在生成字体时用)。

**Spec:** `docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md`(下称 spec)。主人依据:`~/Documents/tendhearth/cc-screens-2026-09-30/CC-设计原则.md`、认可稿 `desktop-redesign-now.html`。前序:`2026-10-01-tendhearth-app-chat.md`(plan 5,手机 `/chat`、`useChat`、`chat:latest` 查询都来自它)。

## Global Constraints

- 工作树 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc/.claude/worktrees/deploy-dev`,分支 `design-unify`(基于 `origin/dev` 474354f7),PR 进 `dev`(squash)。不切分支、不碰兄弟工作树、不用 `git stash`、不暂存 `.superpowers/`。提交信息末尾空一行加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **没有深色模式**:任何样式表不得出现 `prefers-color-scheme: dark`;手机代码不得 import `useColorScheme`;`app.json` `userInterfaceStyle` 为 `"light"`。
- **颜色只从 token 来**:手机 `.tsx` 里不写字面色值(`#xxxxxx` / `rgba(`);桌面「此刻 / 一起做 / 跟 CC 说」三块样式表零字面色值,其余样式表字面色值数只减不增。
- **字重只有 400 / 500**:手机永不设 `fontWeight`(换家族名 `…-Medium`);桌面 CSS `font-weight` 只许 `400`、`500`、`normal`。
- **字体本地打包**:两端运行时不得请求 `fonts.googleapis.com` / `fonts.gstatic.com`;字体旁必须有 `OFL.txt`。手机字体合计 ≤ 30 MB,桌面字体合计 ≤ 20 MB。
- **状态色只上点**:`ok`/`warn`/`bad`/`unknown` 只用于直径 ≤ 10px 的状态点(`bad` 另可用于错误文字);「不知道」永远是 `unknown` 灰,不默认绿。
- **CC 明暗规则**(spec §4):手机 `here ⇔ conn.state === 'online'`;桌面 `here ⇔ presence.presence !== 'down'`。别的信号(外发 offline、snooze)不改明暗。
- **不做没上线的按钮**:手机交办页的「加一张图」删除;不新增任何 daemon 接口。
- **testID / e2e 选择器保留**:spec §5.4、§6.5 列出的变动之外,现有 testID、`id`、`data-pane`、`.cc-life-nav-more`、`.cc-home-details`、`#converse-root`、`#converse-input`、`#settings-open` 一个不改名。Playwright 导航一律用 `clickNav` / `reveal` / `clickRevealed`。
- 根目录测试会 import 的手机文件(`apps/app/src/ui/tokens.ts`、`apps/app/src/ui/type.ts`、`apps/app/src/view/*.ts`)必须纯 TS:不 import `react` / `react-native` / `expo-*`。`packages/design-tokens` 零依赖。
- 手机面向用户的字符串进 `apps/app/src/i18n/en.ts` 与 `zh-Hans.ts`(键一致)。桌面文案是中文写在 HTML / JS 里(沿用)。
- 回路(看退出码,别 grep 输出):
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
  - 手机:`cd apps/app && bun run test && bun run typecheck && bun run export:check`
  - 桌面 e2e:`cd apps/desktop && bun x playwright test`(先确认 4176 端口没被占:`lsof -i :4176`)
  - Maestro(手机结构改动的任务):`cd apps/app && maestro test .maestro/<flow>.yaml`(模拟器上装好 dev build)

## Review Focus

- **字体加载失败 / 慢**:`useFonts` 报错或一直不回 ⇒ 页面照样出来(系统衬线兜底),不白屏、不卡在底色。Task 3 的 `fontGate` 单测钉住。
- **中英混排缺字退回无衬线**:英文界面里出现中文事项标题(用户内容)⇒ 必须用 Noto Serif SC 家族,不能让中文落到 PingFang。Task 3 的 `phoneFont` 单测钉住 `content: 'user'`。
- **CC 没说过话 / 对话读不到**:此刻页不画空气泡、不画占位客套话,CC 照样可点进 `/chat`。Task 5 的 `latestCCLine` 单测(空页、只有「我」的消息、`not_found`)钉住;桌面 Task 9 同理。
- **离线 / 连接中 / 已撤销三态的 CC 与状态行**:离线 = Dark CC + 红点 +「不在线 · HH:MM 同步」;连接中 = Dark CC + 灰点(不知道),绝不绿。Task 4 的 `statusLine` / `ccPresence` 单测逐态钉住;桌面 Task 9 的 `daemonStatusLine` 单测钉住「拉不到 ⇒ 不绿」。
- **桌面此刻 home ↔ chat 切换不丢草稿、`#converse-root` 只有一份**:工作台把 converse 控件搬走再搬回、从 home 发出一句、导航 `converse`,三条路径草稿都在、焦点在输入框。Task 10 的 Playwright 用例钉住。

---

## Phase A — 共用 token 与字体

### Task 1: `packages/design-tokens`(唯一出处)+ 桌面 `tokens.css` 生成 + 一致性守卫

**Files:**
- Create: `packages/design-tokens/package.json`
- Create: `packages/design-tokens/src/index.ts`
- Create: `packages/design-tokens/src/index.test.ts`
- Create: `scripts/build-design-tokens.ts`
- Create: `scripts/design-tokens.guard.test.ts`
- Create: `apps/desktop/src/tokens.css`(生成物)
- Modify: `apps/app/package.json`(加依赖 `"@wechat-cc/design-tokens": "workspace:*"`)

**Interfaces:**
- Produces(`@wechat-cc/design-tokens`):
  - `color: { ground, paper, rail, ink, inkSoft, hair, accent, onAccent, ok, warn, bad, unknown, glow, scrim }`(全是 string)
  - `type TypeRole = 'display'|'wordmark'|'title'|'item'|'body'|'bubble'|'meta'|'small'|'caption'`
  - `typeScale: Record<TypeRole, { desktop: number; phone: number; lineHeight: number; weight: 'regular'|'medium'; tracking: number }>`
  - `fontFamily: { serifLatin: 'Source Serif 4'; serifCJK: 'Noto Serif SC'; mono: 'Geist Mono' }`
  - `fontWeight: { regular: 400; medium: 500 }`
  - `radius: { nav: 8; bubble: 14; sheet: 14; control: 28 }`、`space: { xs: 4; s: 8; m: 12; l: 16; xl: 24; xxl: 36 }`
  - `contrast(fg: string, bg: string): number`(WCAG 2.x,输入 `#rrggbb`)
  - `renderTokensCss(): string`

- [ ] **Step 1: 写失败的单测** `packages/design-tokens/src/index.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { color, typeScale, fontWeight, contrast, renderTokensCss } from './index'

const HEX = /^#[0-9a-f]{6}$/
describe('design tokens', () => {
  it('pins the owner-approved palette (spec §2.1)', () => {
    expect(color.paper).toBe('#faf7f2')
    expect(color.accent).toBe('#4f6b4f')
    expect(color.ink).toBe('#2a2622')
    expect(color.inkSoft).toBe('#70665d')
    expect(color.unknown).toBe(color.inkSoft)
    for (const [k, v] of Object.entries(color)) if (!['glow', 'scrim'].includes(k)) expect(v, k).toMatch(HEX)
  })
  it('text meets AA on every surface; dots meet 3:1', () => {
    for (const bg of [color.paper, color.rail, color.ground]) {
      expect(contrast(color.ink, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color.inkSoft, bg)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color.onAccent, color.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color.accent, color.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color.bad, color.paper)).toBeGreaterThanOrEqual(4.5)
    for (const d of [color.ok, color.warn, color.bad, color.unknown]) expect(contrast(d, color.paper)).toBeGreaterThanOrEqual(3)
  })
  it('only two weights; hierarchy by size', () => {
    expect(Object.values(fontWeight).sort()).toEqual([400, 500])
    expect(typeScale.display.desktop).toBeGreaterThan(typeScale.item.desktop)
    expect(typeScale.display.phone).toBeGreaterThan(typeScale.item.phone)
  })
  it('renders css custom properties for every token and declares light only', () => {
    const css = renderTokensCss()
    expect(css).toContain('--th-paper: #faf7f2;')
    expect(css).toContain('--th-size-display: 48px;')
    expect(css).toContain('--th-lh-display: 1.15;')
    expect(css).toContain('--th-radius-control: 28px;')
    expect(css).toContain('color-scheme: light;')
    expect(css).not.toMatch(/prefers-color-scheme/)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/design-tokens/src/index.test.ts`
Expected: FAIL(`Cannot find module './index'`)

- [ ] **Step 3: 实现** `packages/design-tokens/package.json`

```json
{
  "name": "@wechat-cc/design-tokens",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/design-tokens/src/index.ts`:

```ts
/**
 * Tendhearth 设计 token 的唯一出处(spec 2026-10-01-tendhearth-design-unify §2)。
 * 手机 app 直接 import;桌面的 apps/desktop/src/tokens.css 由 scripts/build-design-tokens.ts 从这里生成。
 * 零依赖、纯 TS —— 根目录与 apps/app 的测试都会 import。
 */
export const color = {
  ground: '#efeae2', paper: '#faf7f2', rail: '#f3eee6',
  ink: '#2a2622', inkSoft: '#70665d', hair: '#e4ddd2',
  accent: '#4f6b4f', onAccent: '#fbfaf6',
  ok: '#5f8a5a', warn: '#b07a2a', bad: '#b5533c', unknown: '#70665d',
  glow: 'rgba(255,214,150,0.55)', scrim: 'rgba(42,38,34,0.36)',
} as const

export type TypeRole = 'display' | 'wordmark' | 'title' | 'item' | 'body' | 'bubble' | 'meta' | 'small' | 'caption'
export const typeScale: Record<TypeRole, { desktop: number; phone: number; lineHeight: number; weight: 'regular' | 'medium'; tracking: number }> = {
  display:  { desktop: 48, phone: 36, lineHeight: 1.15, weight: 'regular', tracking: 0 },
  wordmark: { desktop: 24, phone: 20, lineHeight: 1.2,  weight: 'medium',  tracking: 0.01 },
  title:    { desktop: 22, phone: 20, lineHeight: 1.3,  weight: 'medium',  tracking: 0 },
  item:     { desktop: 18, phone: 17, lineHeight: 1.4,  weight: 'regular', tracking: 0 },
  body:     { desktop: 16, phone: 16, lineHeight: 1.6,  weight: 'regular', tracking: 0 },
  bubble:   { desktop: 15, phone: 15, lineHeight: 1.6,  weight: 'regular', tracking: 0 },
  meta:     { desktop: 14, phone: 14, lineHeight: 1.5,  weight: 'regular', tracking: 0.04 },
  small:    { desktop: 13, phone: 13, lineHeight: 1.5,  weight: 'regular', tracking: 0 },
  caption:  { desktop: 12, phone: 12, lineHeight: 1.4,  weight: 'regular', tracking: 0 },
}
export const fontFamily = { serifLatin: 'Source Serif 4', serifCJK: 'Noto Serif SC', mono: 'Geist Mono' } as const
export const fontWeight = { regular: 400, medium: 500 } as const
export const radius = { nav: 8, bubble: 14, sheet: 14, control: 28 } as const
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 36 } as const

const lum = (hex: string): number => {
  const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}
export function contrast(fg: string, bg: string): number {
  const a = lum(fg), b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const kebab = (s: string) => s.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
export function renderTokensCss(): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(color)) lines.push(`  --th-${kebab(k)}: ${v};`)
  for (const [k, v] of Object.entries(typeScale)) {
    lines.push(`  --th-size-${k}: ${v.desktop}px;`, `  --th-lh-${k}: ${v.lineHeight};`, `  --th-weight-${k}: ${fontWeight[v.weight]};`, `  --th-tracking-${k}: ${v.tracking}em;`)
  }
  for (const [k, v] of Object.entries(radius)) lines.push(`  --th-radius-${k}: ${v}px;`)
  for (const [k, v] of Object.entries(space)) lines.push(`  --th-space-${k}: ${v}px;`)
  lines.push(
    `  --th-font-serif: "${fontFamily.serifLatin}", "${fontFamily.serifCJK}", "Songti SC", "STSong", Georgia, serif;`,
    `  --th-font-mono: "${fontFamily.mono}", ui-monospace, "SF Mono", Menlo, monospace;`,
    '  color-scheme: light;',
  )
  return `/* 生成物:bun scripts/build-design-tokens.ts(出处 packages/design-tokens/src/index.ts)。别手改。 */\n:root {\n${lines.join('\n')}\n}\n`
}
```

- [ ] **Step 4: 跑单测,确认通过**

Run: `bun --bun vitest run packages/design-tokens/src/index.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: 写守卫测试** `scripts/design-tokens.guard.test.ts`

```ts
// 桌面 tokens.css 是生成物:与 packages/design-tokens 渲染结果逐字一致;手机色板就是同一个对象。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { color, renderTokensCss } from '../packages/design-tokens/src/index'
import { palette } from '../apps/app/src/ui/tokens'

describe('one set of design tokens across desktop and phone', () => {
  it('apps/desktop/src/tokens.css is up to date (run: bun scripts/build-design-tokens.ts)', () => {
    expect(readFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), 'utf8')).toBe(renderTokensCss())
  })
  it('phone palette is the shared palette (no mirror to drift)', () => {
    expect(palette).toBe(color)
  })
})
```

(第二条在 Task 3 改完手机 `tokens.ts` 之前会失败 —— 本任务先用 `it.todo` 占住第二条,Task 3 Step 1 把它改回 `it`。)

- [ ] **Step 6: 写生成脚本** `scripts/build-design-tokens.ts`

```ts
// 重新生成 apps/desktop/src/tokens.css。改了 packages/design-tokens 之后跑一次,把生成物一起提交。
import { writeFileSync } from 'node:fs'
import { renderTokensCss } from '../packages/design-tokens/src/index'
writeFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), renderTokensCss())
console.log('wrote apps/desktop/src/tokens.css')
```

Run: `bun scripts/build-design-tokens.ts && bun install`
然后 `bun --bun vitest run scripts/design-tokens.guard.test.ts packages/design-tokens`
Expected: PASS(第二条 todo)

- [ ] **Step 7: 根回路** `bun run typecheck && bun run depcheck` → 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add packages/design-tokens scripts/build-design-tokens.ts scripts/design-tokens.guard.test.ts apps/desktop/src/tokens.css apps/app/package.json bun.lock
git commit -m "design tokens:Tendhearth 唯一出处 + 桌面 tokens.css 生成物与一致性守卫

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 字体裁剪入库(两端)+ 授权与体积守卫

**Files:**
- Create: `scripts/fonts/build-fonts.sh`
- Create: `scripts/fonts/sources.lock.json`
- Create: `apps/app/assets/fonts/{NotoSerifSC-Regular,NotoSerifSC-Medium,SourceSerif4-Regular,SourceSerif4-Medium}.ttf`、`apps/app/assets/fonts/OFL.txt`
- Create: `apps/desktop/src/fonts/{noto-serif-sc-400,noto-serif-sc-500,source-serif-4-400,source-serif-4-500}.woff2`、`apps/desktop/src/fonts/OFL.txt`
- Delete: `apps/desktop/src/fonts/geist-variable-latin.woff2`(Geist 无衬线退役;`geist-mono-variable-latin.woff2` 保留)
- Modify: `scripts/design-tokens.guard.test.ts`(加字体用例)

**Interfaces:**
- Produces: 上面 8 个字体文件的**确切文件名**(Task 3 的 `FONT_FILES`、Task 8 的 `@font-face` 引用它们)。手机家族名 = 文件名去扩展名(`NotoSerifSC-Regular` 等)。

- [ ] **Step 1: 写失败的守卫用例**(追加到 `scripts/design-tokens.guard.test.ts`)

```ts
import { statSync, existsSync, readdirSync } from 'node:fs'
const APP_FONTS = ['NotoSerifSC-Regular.ttf', 'NotoSerifSC-Medium.ttf', 'SourceSerif4-Regular.ttf', 'SourceSerif4-Medium.ttf']
const DESK_FONTS = ['noto-serif-sc-400.woff2', 'noto-serif-sc-500.woff2', 'source-serif-4-400.woff2', 'source-serif-4-500.woff2']
const MB = 1024 * 1024
const sizeOf = (dir: URL, names: string[]) => names.reduce((n, f) => n + statSync(new URL(f, dir)).size, 0)

describe('bundled fonts (spec §3)', () => {
  const app = new URL('../apps/app/assets/fonts/', import.meta.url)
  const desk = new URL('../apps/desktop/src/fonts/', import.meta.url)
  it('both apps ship the serif families with their OFL licence', () => {
    for (const f of [...APP_FONTS, 'OFL.txt']) expect(existsSync(new URL(f, app)), f).toBe(true)
    for (const f of [...DESK_FONTS, 'OFL.txt']) expect(existsSync(new URL(f, desk)), f).toBe(true)
    expect(readFileSync(new URL('OFL.txt', app), 'utf8')).toMatch(/SIL OPEN FONT LICENSE/i)
  })
  it('stays within the size budget', () => {
    expect(sizeOf(app, APP_FONTS)).toBeLessThanOrEqual(30 * MB)
    expect(sizeOf(desk, DESK_FONTS)).toBeLessThanOrEqual(20 * MB)
  })
  it('the sans Geist is retired; only Geist Mono stays for code', () => {
    expect(readdirSync(desk).filter(f => /^geist-variable/.test(f))).toEqual([])
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run scripts/design-tokens.guard.test.ts`
Expected: FAIL(文件不存在)

- [ ] **Step 3: 写生成脚本** `scripts/fonts/build-fonts.sh`

```bash
#!/usr/bin/env bash
# 一次性生成两端的衬线字体(spec 2026-10-01 §3)。只在换字体时跑;生成物入库,运行时不下载。
# 依赖:python3 + `pip install fonttools brotli`。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
GF=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -fsSL "$GF/notoserifsc/NotoSerifSC%5Bwght%5D.ttf" -o "$WORK/noto.ttf"
curl -fsSL "$GF/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf" -o "$WORK/source.ttf"
curl -fsSL "$GF/notoserifsc/OFL.txt" -o "$WORK/OFL-noto.txt"
curl -fsSL "$GF/sourceserif4/OFL.txt" -o "$WORK/OFL-source.txt"
shasum -a 256 "$WORK/noto.ttf" "$WORK/source.ttf"   # 抄进 scripts/fonts/sources.lock.json

CJK="U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2190-21FF,U+3000-303F,U+4E00-9FFF,U+FF00-FFEF"
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215"
for W in 400 500; do
  python3 -m fontTools.varLib.instancer "$WORK/noto.ttf" wght=$W -o "$WORK/noto-$W.ttf"
  python3 -m fontTools.varLib.instancer "$WORK/source.ttf" wght=$W opsz=16 -o "$WORK/source-$W.ttf"
  NAME=$([ $W = 400 ] && echo Regular || echo Medium)
  pyftsubset "$WORK/noto-$W.ttf" --unicodes="$CJK" --layout-features='*' --output-file="$ROOT/apps/app/assets/fonts/NotoSerifSC-$NAME.ttf"
  pyftsubset "$WORK/source-$W.ttf" --unicodes="$LATIN" --layout-features='*' --output-file="$ROOT/apps/app/assets/fonts/SourceSerif4-$NAME.ttf"
  pyftsubset "$WORK/noto-$W.ttf" --unicodes="$CJK" --layout-features='*' --flavor=woff2 --output-file="$ROOT/apps/desktop/src/fonts/noto-serif-sc-$W.woff2"
  pyftsubset "$WORK/source-$W.ttf" --unicodes="$LATIN" --layout-features='*' --flavor=woff2 --output-file="$ROOT/apps/desktop/src/fonts/source-serif-4-$W.woff2"
done
# 两份 OFL 合成一份(各自的版权行都保留)
for D in "$ROOT/apps/app/assets/fonts" "$ROOT/apps/desktop/src/fonts"; do
  { cat "$WORK/OFL-noto.txt"; printf '\n\n----- Source Serif 4 -----\n\n'; cat "$WORK/OFL-source.txt"; } > "$D/OFL.txt"
done
du -ch "$ROOT"/apps/app/assets/fonts/*.ttf "$ROOT"/apps/desktop/src/fonts/*-serif-*.woff2 | tail -1
```

注意:手机 `NotoSerifSC-*` 的家族内部名(name table ID 1)必须与文件名一致,RN 安卓按文件名注册、iOS 按 `useFonts` 的键注册,键就用文件名去扩展名(Task 3),所以不用改 name table。

- [ ] **Step 4: 跑脚本、记 sha256、删 Geist 无衬线**

```bash
mkdir -p apps/app/assets/fonts && bash scripts/fonts/build-fonts.sh
git rm apps/desktop/src/fonts/geist-variable-latin.woff2
```

把脚本打出的两行 sha256 写进 `scripts/fonts/sources.lock.json`:

```json
{ "fetched": "2026-10-01", "notoSerifSC": { "url": "google/fonts ofl/notoserifsc/NotoSerifSC[wght].ttf", "sha256": "<脚本打印的值>" }, "sourceSerif4": { "url": "google/fonts ofl/sourceserif4/SourceSerif4[opsz,wght].ttf", "sha256": "<脚本打印的值>" } }
```

体积若超预算:按 spec §3 先删 CJK Medium(两端各一个文件,`APP_FONTS`/`DESK_FONTS` 去掉对应项,Task 3 / Task 8 里 medium 角色的中文退回 Regular),仍超就停下报告主人。

- [ ] **Step 5: 跑守卫,确认通过**

Run: `bun --bun vitest run scripts/design-tokens.guard.test.ts`
Expected: PASS(字体三条;手机色板那条仍是 todo)。注意 `styles.css` 里 Geist 的 `@font-face` 还在引用被删的文件 —— Task 8 处理;这一步桌面字体会退回系统字,不影响测试。

- [ ] **Step 6: Commit**

```bash
git add scripts/fonts apps/app/assets/fonts apps/desktop/src/fonts scripts/design-tokens.guard.test.ts
git commit -m "字体:Noto Serif SC + Source Serif 4 本地打包(两端)+ OFL 与体积守卫;退役 Geist 无衬线

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase B — 手机

### Task 3: 手机去深色 + 衬线字体加载 + `Txt` / `TextField` + 样式守卫(棘轮)

**Files:**
- Modify: `apps/app/src/ui/tokens.ts`、`apps/app/src/ui/tokens.test.ts`
- Modify: `apps/app/src/ui/useTheme.ts`
- Create: `apps/app/src/ui/type.ts`、`apps/app/src/ui/type.test.ts`
- Create: `apps/app/src/ui/font-files.ts`
- Create: `apps/app/src/ui/Txt.tsx`、`apps/app/src/ui/TextField.tsx`
- Create: `apps/app/src/ui/style.guard.test.ts`
- Modify: `apps/app/src/app/_layout.tsx`、`apps/app/app.json`
- Modify: `scripts/design-tokens.guard.test.ts`(todo → it)

**Interfaces:**
- Consumes: `@wechat-cc/design-tokens` 的 `color`、`typeScale`、`TypeRole`、`radius`、`space`;Task 2 的四个 TTF 文件名。
- Produces:
  - `apps/app/src/ui/tokens.ts`:`export const palette = color`(同一对象)、`export { radius, space }`、`export type Palette = typeof color`
  - `useTheme(): { c: Palette & LegacyAliases }`(`LegacyAliases` 见下,Task 6 删)
  - `phoneFont(role: TypeRole | 'code', lang: Lang, content?: 'ui' | 'user'): { fontFamily: string; fontSize: number; lineHeight: number; letterSpacing: number }`(`fontFamily` 为 `'mono'` 时由 `Txt` 换成平台等宽)
  - `fontGate(loaded: boolean, error: Error | null): 'wait' | 'go'`
  - `<Txt role? tone? content? numberOfLines? style? testID? …TextProps>`;`tone: 'ink' | 'inkSoft' | 'accent' | 'bad' | 'onAccent'`
  - `<TextField role? content? …TextInputProps>`(默认 `role='body'`、`content='user'`)
  - `FONT_FILES: Record<string, number>`(`useFonts` 的参数)

- [ ] **Step 1: 失败的测试**

`apps/app/src/ui/tokens.test.ts` 整个替换:

```ts
import { describe, it, expect } from 'vitest'
import { color } from '@wechat-cc/design-tokens'
import { palette } from './tokens'

describe('设计 token', () => {
  it('只有一套色板,就是共用包里那一份(没有深色)', () => {
    expect(palette).toBe(color)
    expect('dark' in (palette as object)).toBe(false)
  })
})
```

`apps/app/src/ui/type.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { phoneFont, fontGate } from './type'

describe('phoneFont', () => {
  it('中文界面用 Noto Serif SC,英文界面用 Source Serif 4', () => {
    expect(phoneFont('body', 'zh-Hans').fontFamily).toBe('NotoSerifSC-Regular')
    expect(phoneFont('body', 'en').fontFamily).toBe('SourceSerif4-Regular')
  })
  it('用户内容一律 Noto Serif SC(英文界面里的中文标题不落到无衬线)', () => {
    expect(phoneFont('item', 'en', 'user').fontFamily).toBe('NotoSerifSC-Regular')
  })
  it('中等字重靠换家族名,不靠 fontWeight', () => {
    expect(phoneFont('wordmark', 'en').fontFamily).toBe('SourceSerif4-Medium')
    expect(phoneFont('title', 'zh-Hans').fontFamily).toBe('NotoSerifSC-Medium')
    expect(Object.keys(phoneFont('title', 'zh-Hans'))).not.toContain('fontWeight')
  })
  it('字号与行高来自共用 token(手机列)', () => {
    expect(phoneFont('display', 'zh-Hans')).toMatchObject({ fontSize: 36, lineHeight: Math.round(36 * 1.15) })
    expect(phoneFont('meta', 'en').letterSpacing).toBeCloseTo(14 * 0.04)
  })
  it('代码用等宽', () => { expect(phoneFont('code', 'en').fontFamily).toBe('mono') })
})

describe('fontGate', () => {
  it('加载完或出错都放行;只有既没好也没错才等', () => {
    expect(fontGate(false, null)).toBe('wait')
    expect(fontGate(true, null)).toBe('go')
    expect(fontGate(false, new Error('x'))).toBe('go')
  })
})
```

`apps/app/src/ui/style.guard.test.ts`:

```ts
// 手机样式守卫(spec 2026-10-01 §5):没有深色、不设字重、不写字面色值、文字都走 Txt / TextField。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, out) : out.push(f) }
  return out
}
const TSX = walk(SRC).filter(f => f.endsWith('.tsx'))
const rel = (f: string) => relative(SRC, f)
/** 还没换到 Txt / TextField 的页面。Task 5 / 6 / 7 逐个删,Task 7 结束时必须为空。 */
export const NOT_YET_MIGRATED = new Set<string>([
  'app/(tabs)/index.tsx', 'app/(tabs)/together.tsx', 'app/approval/[id].tsx', 'app/chat.tsx', 'app/compose.tsx',
  'app/connections.tsx', 'app/dev-push-key.tsx', 'app/devices.tsx', 'app/matter/[id].tsx', 'app/pair.tsx',
  'app/push-open.tsx', 'app/sessions/[key].tsx', 'app/sessions/index.tsx', 'app/settings.tsx', 'app/welcome.tsx',
  'ui/Button.tsx', 'ui/CCFigure.tsx', 'ui/ConnectionNotice.tsx', 'ui/DemoBanner.tsx', 'ui/Placeholder.tsx',
  'ui/PushBanner.tsx', 'ui/SayBar.tsx', 'ui/StatusPill.tsx', 'ui/TabBar.tsx', 'ui/TopBar.tsx', 'push/PushRouter.tsx',
])

describe('phone style guard', () => {
  it('no dark mode anywhere', () => {
    for (const f of walk(SRC).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/useColorScheme|DarkTheme/)
  })
  it('never sets fontWeight (weights come from the family name)', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/fontWeight/)
  })
  it('no literal colours in components', () => {
    for (const f of TSX) expect(readFileSync(f, 'utf8').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], rel(f)).toEqual([])
  })
  it('text goes through Txt / TextField (ratchet: NOT_YET_MIGRATED only shrinks)', () => {
    const offenders = TSX.filter(f => !['ui/Txt.tsx', 'ui/TextField.tsx'].includes(rel(f)))
      .filter(f => /import\s*\{[^}]*\b(Text|TextInput)\b[^}]*\}\s*from\s*'react-native'/.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders.filter(f => !NOT_YET_MIGRATED.has(f))).toEqual([])
    expect([...NOT_YET_MIGRATED].filter(f => !offenders.includes(f)), '已迁移的页面请从 NOT_YET_MIGRATED 删掉').toEqual([])
  })
})
```

把 `scripts/design-tokens.guard.test.ts` 第二条的 `it.todo` 改回 `it`。

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun run test` → FAIL(`type.ts` 不存在、`palette` 不等、`fontWeight` 命中 35 处、`useColorScheme` 命中)。
(NOT_YET_MIGRATED 若与实际 import 不一致,先按实际 offenders 校正这张表 —— 它是起点快照,只许后续任务删。)

- [ ] **Step 3: 实现**

`apps/app/src/ui/tokens.ts`:

```ts
// 色值、字号、形状的唯一出处是 @wechat-cc/design-tokens(spec 2026-10-01 §2)。只有一套:页面永远是同一张暖纸。
import { color, radius, space } from '@wechat-cc/design-tokens'
export const palette = color
export type Palette = typeof color
export { radius, space }
```

`apps/app/src/ui/useTheme.ts`:

```ts
import { palette, type Palette } from './tokens'

/** 旧键名 → 新 token 的过渡别名(Task 6 删掉,守卫测试届时禁止旧键名)。 */
type LegacyAliases = { bg: string; card: string; muted: string; line: string; primary: string; primaryInk: string; navOnBg: string; navOnInk: string; accentSoft: string; danger: string }
const c: Palette & LegacyAliases = {
  ...palette,
  bg: palette.paper, card: palette.paper, muted: palette.inkSoft, line: palette.hair,
  primary: palette.accent, primaryInk: palette.onAccent, navOnBg: palette.rail, navOnInk: palette.ink,
  accentSoft: 'transparent', danger: palette.bad,
}
/** 不跟系统变:永远同一套。 */
export function useTheme() { return { c } }
```

`apps/app/src/ui/type.ts`:

```ts
// 纯 TS:字号 / 行高 / 家族的选择(spec §2.2、§3)。字重永远靠家族名,不设 fontWeight。
import { typeScale, type TypeRole } from '@wechat-cc/design-tokens'
import type { Lang } from '../i18n'

export function phoneFont(role: TypeRole | 'code', lang: Lang, content: 'ui' | 'user' = 'ui') {
  if (role === 'code') return { fontFamily: 'mono', fontSize: 13, lineHeight: 19, letterSpacing: 0 }
  const s = typeScale[role]
  const cjk = content === 'user' || lang === 'zh-Hans'
  const weight = s.weight === 'medium' ? 'Medium' : 'Regular'
  return {
    fontFamily: `${cjk ? 'NotoSerifSC' : 'SourceSerif4'}-${weight}`,
    fontSize: s.phone,
    lineHeight: Math.round(s.phone * s.lineHeight),
    letterSpacing: s.phone * s.tracking,
  }
}

/** 字体没好也没错 ⇒ 等;好了或出错 ⇒ 放行(出错退回系统衬线,绝不卡住页面)。 */
export function fontGate(loaded: boolean, error: Error | null): 'wait' | 'go' {
  return loaded || error ? 'go' : 'wait'
}
```

`apps/app/src/ui/font-files.ts`:

```ts
// useFonts 的参数:键 = RN 里用的家族名(= 文件名去扩展名)。
export const FONT_FILES = {
  'NotoSerifSC-Regular': require('../../assets/fonts/NotoSerifSC-Regular.ttf'),
  'NotoSerifSC-Medium': require('../../assets/fonts/NotoSerifSC-Medium.ttf'),
  'SourceSerif4-Regular': require('../../assets/fonts/SourceSerif4-Regular.ttf'),
  'SourceSerif4-Medium': require('../../assets/fonts/SourceSerif4-Medium.ttf'),
} as const
```

`apps/app/src/ui/Txt.tsx`:

```tsx
import { Text, type TextProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { monoFamily } from './fonts'
import { phoneFont } from './type'
import { useTheme } from './useTheme'

export type Tone = 'ink' | 'inkSoft' | 'accent' | 'bad' | 'onAccent'
export function Txt({ role = 'body', tone = 'ink', content = 'ui', style, ...rest }: TextProps & { role?: TypeRole | 'code'; tone?: Tone; content?: 'ui' | 'user' }) {
  const { c } = useTheme()
  const lang = useLang()
  const f = phoneFont(role, lang, content)
  return <Text {...rest} style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c[tone] }, style]} />
}
```

`apps/app/src/ui/TextField.tsx`:

```tsx
import { forwardRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { phoneFont } from './type'
import { useTheme } from './useTheme'

export const TextField = forwardRef<TextInput, TextInputProps & { role?: TypeRole; content?: 'ui' | 'user' }>(function TextField({ role = 'body', content = 'user', style, ...rest }, ref) {
  const { c } = useTheme()
  const lang = useLang()
  return <TextInput ref={ref} placeholderTextColor={c.inkSoft} {...rest} style={[{ ...phoneFont(role, lang, content), color: c.ink }, style]} />
})
```

`apps/app/src/ui/fonts.ts`:删掉 `serifFamily`(标题字体改由 `Txt` 决定),只留 `monoFamily`。现有引用 `serifFamily` 的页面在本任务里先把 `fontFamily: serifFamily` 删掉(下一步换 `Txt` 时自然消失)。

`apps/app/src/app/_layout.tsx` 的 `Themed`:

```tsx
import { useFonts } from 'expo-font'
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { FONT_FILES } from '../ui/font-files'
import { palette } from '../ui/tokens'
import { fontGate } from '../ui/type'
// …(其余 import 不变,删掉 useColorScheme / DarkTheme)

function Themed() {
  const session = useSession()
  const lang = useLang()
  const [loaded, error] = useFonts(FONT_FILES)
  const c = palette
  const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: c.paper, card: c.paper, text: c.ink, border: c.hair, primary: c.accent } }
  if (!session.ready || fontGate(loaded, error) === 'wait') return <View style={{ flex: 1, backgroundColor: c.paper }} />
  return (
    <BackendProvider lang={lang} pairing={session.pairing} onRevoked={session.dropStoredPairing}>
      <PushProvider>
        <ThemeProvider value={theme}>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.paper } }}>
            {/* 三个 Stack.Screen 不变 */}
          </Stack>
          <PushRouter />
        </ThemeProvider>
      </PushProvider>
    </BackendProvider>
  )
}
```

顶部注释里「主题跟 useColorScheme()」改成「页面永远同一张暖纸(spec 2026-10-01 §1.8)」。

`apps/app/app.json`:`"userInterfaceStyle": "light"`;splash 插件删掉 `"dark"` 块,`backgroundColor` 改 `"#faf7f2"`;安卓 `adaptiveIcon.backgroundColor` 不动(图标不是页面)。

本任务里**全部**手机组件 / 页面先做两件机械事,让守卫前三条通过(结构与 `Txt` 迁移留给后面):
1. 删掉每一处 `fontWeight: '…'`(层级之后靠 `Txt role`;Task 5–7 换 `Txt` 时补上 medium 角色)。
2. `TopBar.tsx`、`CCFigure.tsx` 里读 `scheme` 的地方暂时固定用 `lit`(Task 4 换成真信号)。

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check`;根目录 `bun --bun vitest run scripts/design-tokens.guard.test.ts`
Expected: 全 PASS;`export:check` 打包成功(说明 TTF 能被 metro 收进包)。

- [ ] **Step 5: 真机 / 模拟器目测一次**:`cd apps/app && bunx expo run:ios`,系统切深色 ⇒ 页面仍是暖纸;中文字是宋体衬线。截一张放 `~/Documents/tendhearth/cc-screens-2026-10-01-design/phone/_task3-dark-system.png`。

- [ ] **Step 6: Commit**

```bash
git add apps/app scripts/design-tokens.guard.test.ts
git commit -m "手机:去掉深色模式、本地衬线字体加载、Txt/TextField 与样式守卫(棘轮)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 手机 CC 明暗 + 顶栏状态行(= CC 的连接入口)

**Files:**
- Create: `apps/app/src/view/presence.ts`、`apps/app/src/view/presence.test.ts`
- Modify: `apps/app/src/ui/CCFigure.tsx`、`apps/app/src/ui/TopBar.tsx`、所有 `<TopBar`/`<CCFigure` 调用处(见 `grep -rn "<TopBar\|<CCFigure" apps/app/src/app`)
- Modify: `apps/app/src/backend/demo.ts`(home 主题 `level: 'present'` → `'ok'`,对齐 daemon 词表)
- Modify: `apps/app/src/i18n/en.ts`、`zh-Hans.ts`
- Modify: `apps/app/src/ui/style.guard.test.ts`(删 `ui/CCFigure.tsx`、`ui/TopBar.tsx`)

**Interfaces:**
- Consumes: `Connection`(`apps/app/src/backend/types.ts`)、`formatSynced(ts, now, lang)`(`view/connection.ts`)、`Txt`、`Dot`。
- Produces:
  - `export type CCPresence = 'here' | 'away'`
  - `ccPresence(c: Connection): CCPresence`
  - `statusLine(c: Connection, now: number, lang: Lang): { dot: 'ok' | 'bad' | 'unknown'; text: string }`
  - `<CCFigure size presence mood? />`(`presence` 必填)
  - `<TopBar title? onBack? showConnection? onAvatar? onConnection? connectionTestID? />`(TopBar 自己读 `useConnection()`;删掉 `connection` 属性)

- [ ] **Step 1: 失败的测试** `apps/app/src/view/presence.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { ccPresence, statusLine } from './presence'

const at = (h: number, m: number) => new Date(2026, 9, 1, h, m).getTime()
const conn = (state: 'online' | 'connecting' | 'offline' | 'revoked', lastSyncedAt: number | null = null) => ({ state, lastSyncedAt, epoch: 1 })

describe('CC 的明暗只看够不够得着家里的电脑', () => {
  it('online ⇒ here;其他一律 away', () => {
    expect(ccPresence(conn('online'))).toBe('here')
    for (const s of ['connecting', 'offline', 'revoked'] as const) expect(ccPresence(conn(s))).toBe('away')
  })
})

describe('顶栏状态行', () => {
  const now = at(21, 0)
  it('在线:绿点', () => expect(statusLine(conn('online'), now, 'zh-Hans')).toEqual({ dot: 'ok', text: '家里的电脑 · 在线' }))
  it('离线:红点 + 上次同步时间', () => expect(statusLine(conn('offline', at(20, 34)), now, 'zh-Hans')).toEqual({ dot: 'bad', text: '家里的电脑 · 不在线 · 20:34 同步' }))
  it('离线且从没同步过:不编时间', () => expect(statusLine(conn('offline'), now, 'zh-Hans').text).toBe('家里的电脑 · 不在线'))
  it('连接中:灰点(不知道),绝不绿', () => expect(statusLine(conn('connecting'), now, 'en')).toEqual({ dot: 'unknown', text: 'Home computer · connecting' }))
  it('已撤销:红点', () => expect(statusLine(conn('revoked'), now, 'zh-Hans')).toEqual({ dot: 'bad', text: '家里的电脑 · 已解除配对' }))
})
```

- [ ] **Step 2: 跑,确认失败** — `cd apps/app && bunx vitest run src/view/presence.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

i18n(两份都加,键一致):

| 键 | zh-Hans | en |
|---|---|---|
| `common.computerConnecting` | `正在连接` | `connecting` |
| `common.computerOffline` | `不在线` | `offline` |
| `common.computerRevoked` | `已解除配对` | `unpaired` |
| `common.syncedAt` | `{time} 同步` | `synced {time}` |
| `common.openConnections` | `CC 的连接` | `CC's connections` |

确认 `common.computerOnline` 的 en 值为 `online`(已是)。

`apps/app/src/view/presence.ts`:

```ts
// CC 的明暗与顶栏状态行(spec 2026-10-01 §4)。纯 TS。
import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export type CCPresence = 'here' | 'away'

/** 隧道握手成功、daemon 在答话 ⇒ 在身边。电脑合盖 / 关机 / daemon 没跑都落到「够不着」。 */
export function ccPresence(c: Connection): CCPresence {
  return c.state === 'online' ? 'here' : 'away'
}

export function statusLine(c: Connection, now: number, lang: Lang): { dot: 'ok' | 'bad' | 'unknown'; text: string } {
  const home = t(lang, 'common.computerHome')
  if (c.state === 'online') return { dot: 'ok', text: `${home} · ${t(lang, 'common.computerOnline')}` }
  if (c.state === 'connecting') return { dot: 'unknown', text: `${home} · ${t(lang, 'common.computerConnecting')}` }
  if (c.state === 'revoked') return { dot: 'bad', text: `${home} · ${t(lang, 'common.computerRevoked')}` }
  const synced = c.lastSyncedAt === null ? '' : ` · ${t(lang, 'common.syncedAt', { time: formatSynced(c.lastSyncedAt, now, lang) })}`
  return { dot: 'bad', text: `${home} · ${t(lang, 'common.computerOffline')}${synced}` }
}
```

`apps/app/src/ui/CCFigure.tsx`:签名改为 `CCFigure({ size, presence, mood }: { size: number; presence: CCPresence; mood?: string })`,`source={presence === 'here' ? lit : unlit}`;删掉 `useTheme` 的 `scheme`;呼吸动画只在 `here` 时跑(`away` 静止 —— Dark CC 是「安静」)。

`apps/app/src/ui/TopBar.tsx` 改成:

```tsx
import { useEffect, useState } from 'react'
import { Image, Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { ccPresence, statusLine } from '../view/presence'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')

// 左:返回 / 标题;右:「● 家里的电脑 · 在线」(传了 onConnection 就是 CC 的连接入口)+ 头像(进设置)。
export function TopBar({ title, onBack, showConnection = true, onAvatar, onConnection, connectionTestID }: {
  title?: string; onBack?: () => void; showConnection?: boolean; onAvatar?: () => void; onConnection?: () => void; connectionTestID?: string
}) {
  const lang = useLang()
  const conn = useConnection()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id) }, [])
  const s = statusLine(conn, now, lang)
  const status = (
    <View accessible testID="topbar-connection" accessibilityLabel={s.text} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
      <Dot kind={s.dot} size={8} />
      <Txt role="small" tone="inkSoft" numberOfLines={1}>{s.text}</Txt>
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <Pressable accessibilityRole="button" testID="topbar-back" accessibilityLabel={t(lang, 'common.back')} onPress={onBack} hitSlop={12}>
          <Txt role="title">‹</Txt>
        </Pressable>
      ) : null}
      <Txt role="wordmark" numberOfLines={1} style={{ flex: 1 }}>{title ?? ''}</Txt>
      {showConnection ? (onConnection ? (
        <Pressable testID={connectionTestID} accessibilityRole="button" accessibilityLabel={`${t(lang, 'common.openConnections')}, ${s.text}`} onPress={onConnection} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>{status}</Pressable>
      ) : status) : null}
      <Pressable accessibilityRole="button" testID="topbar-settings" accessibilityLabel={t(lang, 'settings.title')} onPress={onAvatar} hitSlop={8}
        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Image source={ccPresence(conn) === 'here' ? lit : unlit} style={{ width: 28, height: 28 }} resizeMode="contain" />
      </Pressable>
    </View>
  )
}
```

(头像去掉了 `navOnBg` 圆底 —— 原则「不加图标圆圈」。)
所有调用处:删 `connection={…}` 属性;`<CCFigure>` 加 `presence={ccPresence(conn)}`(各页已有或补上 `const conn = useConnection()`)。此刻页的 `<TopBar>` 加 `onConnection={() => router.push('/connections')} connectionTestID="now-connections"`(此刻页正文那一行入口留到 Task 5 删)。

`apps/app/src/backend/demo.ts` 第 140 行:`presenceState: { level: 'ok', activity: unread > 0 ? 'working' : 'idle' }`(daemon 的 level 词表是 `ok|degraded|offline`,activity 词表见 `packages/protocol/src/api.ts` 的 `Presence`)。

`style.guard.test.ts` 的 `NOT_YET_MIGRATED` 删掉 `ui/TopBar.tsx`、`ui/CCFigure.tsx`(若 CCFigure 已不 import `Text`)。

- [ ] **Step 4: 跑** `cd apps/app && bun run test && bun run typecheck` → PASS。

- [ ] **Step 5: Maestro 回归**:`maestro test .maestro/connections.yaml`(`now-connections` 现在在顶栏;Task 5 之前正文那行也还在,两者同 testID —— 把正文那行的 testID 本任务先改成 `now-connections-row`,Task 5 删)。Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/app
git commit -m "手机:CC 明暗来自真实连接(在线=Light / 够不着=Dark)+ 顶栏状态行做 CC 的连接入口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 手机「此刻」照稿重排

**Files:**
- Modify: `apps/app/src/view/now.ts`、`apps/app/src/view/now.test.ts`
- Modify: `apps/app/src/app/(tabs)/index.tsx`
- Modify: `apps/app/src/ui/SayBar.tsx`
- Modify: `apps/app/src/i18n/{en,zh-Hans,index}.ts`、`apps/app/src/i18n/i18n.test.ts`
- Modify: `apps/app/.maestro/{demo-walkthrough,approve,chat,connections,push-open}.yaml`(只在用到的地方)
- Modify: `apps/app/src/ui/style.guard.test.ts`(删 `app/(tabs)/index.tsx`、`ui/SayBar.tsx`)

**Interfaces:**
- Consumes: `ApprovalItemT`(`{taskId, kind: 'permission'|'question', id, summary}`)、`MatterT`、`ChatPageT`、`CCFigure`、`ccPresence`、`TopBar`、`Txt`、`useQuery('chat:latest', …)`(plan 5 的同一个键,与 `/chat` 共用缓存)。
- Produces:
  - `nowView(input: { approvals: ApprovalItemT[]; matters: MatterT[]; hour: number }): { greetingKey: 'now.greetingMorning'|'now.greetingAfternoon'|'now.greetingEvening'; waiting: WaitingRow[] }`
  - `type WaitingRow = { taskId: string; kind: 'permission' | 'question'; firstRequestId: string; count: number; fallback: string; matterTitle: string }`
  - `latestCCLine(page: ChatPageT | undefined): { text: string; at: number } | null`
  - `matterStatus` 保持导出(together 视图在用)
  - i18n:`CountKey` 加 `'now.waiting'`

- [ ] **Step 1: 失败的测试** —— `apps/app/src/view/now.test.ts` 里关于 `needsYou` / `together` 的用例替换为:

```ts
import { describe, it, expect } from 'vitest'
import { nowView, latestCCLine } from './now'

const a = (taskId: string, kind: 'permission' | 'question', id: string, summary: string) => ({ taskId, kind, id, summary })
const m = (id: string, title: string) => ({ id, title, kind: 'task', status: 'open', updatedAt: 1 }) as any

describe('nowView', () => {
  it('按任务合并等你的事;有权限就算「看清楚」,只有问题算「回答」', () => {
    const v = nowView({ hour: 21, matters: [m('t1', '作品集'), m('t2', '出差')], approvals: [
      a('t1', 'question', 'q1', '哪种风格?'), a('t1', 'permission', 'p1', '装图片组件?'), a('t2', 'question', 'q2', '哪天出发?'),
    ] })
    expect(v.greetingKey).toBe('now.greetingEvening')
    expect(v.waiting).toEqual([
      { taskId: 't1', kind: 'permission', firstRequestId: 'q1', count: 2, fallback: '哪种风格?', matterTitle: '作品集' },
      { taskId: 't2', kind: 'question', firstRequestId: 'q2', count: 1, fallback: '哪天出发?', matterTitle: '出差' },
    ])
  })
  it('事项标题拿不到就给空串(行上只剩标题一行),不编', () => {
    expect(nowView({ hour: 9, matters: [], approvals: [a('x', 'permission', 'p', 's')] }).waiting[0]!.matterTitle).toBe('')
  })
  it('三档问候', () => {
    expect(nowView({ hour: 5, matters: [], approvals: [] }).greetingKey).toBe('now.greetingMorning')
    expect(nowView({ hour: 12, matters: [], approvals: [] }).greetingKey).toBe('now.greetingAfternoon')
    expect(nowView({ hour: 4, matters: [], approvals: [] }).greetingKey).toBe('now.greetingEvening')
  })
})

describe('latestCCLine', () => {
  const msg = (id: string, role: 'me' | 'cc', text: string, at: number) => ({ id, role, text, at, source: 'wechat', truncated: false }) as any
  const page = (messages: any[]) => ({ matterId: 'c', title: 'CC', messages, hasMore: false, nextBefore: null, pending: null, failed: null }) as any
  it('取最近一条 CC 说的、非空的话', () => {
    expect(latestCCLine(page([msg('1', 'cc', '早', 1), msg('2', 'me', '在吗', 2), msg('3', 'cc', '行程整理好了', 3), msg('4', 'me', '好', 4)])))
      .toEqual({ text: '行程整理好了', at: 3 })
  })
  it('没页 / 空页 / 只有「我」/ CC 的话全是空白 ⇒ null(不画空气泡)', () => {
    expect(latestCCLine(undefined)).toBeNull()
    expect(latestCCLine(page([]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'me', 'hi', 1)]))).toBeNull()
    expect(latestCCLine(page([msg('1', 'cc', '   ', 1)]))).toBeNull()
  })
})
```

`i18n.test.ts`:「插值」用例改用 `now.waiting` —— `expect(tCount('en', 'now.waiting', 2)).toBe('2 things waiting for you')`、`expect(tCount('en', 'now.waiting', 1)).toBe('1 thing waiting for you')`、`expect(tCount('zh-Hans', 'now.waiting', 2)).toBe('2 件事等你')`;「一起做的计数」用例若 `now.togetherCount` 在别处(together 页)还在用就保留,否则连键一起删。

- [ ] **Step 2: 跑,确认失败**:`cd apps/app && bunx vitest run src/view/now.test.ts src/i18n` → FAIL。

- [ ] **Step 3: 实现** `apps/app/src/view/now.ts`

```ts
import type { ApprovalItemT, AgentsTopicT, ChatPageT, MatterT } from '../backend/types'
import { statusOfMatter, type StatusKey } from './status'

export function matterStatus(m: MatterT, agents: AgentsTopicT, pending: number): StatusKey {
  const t = agents.tasks.find(x => x.id === m.id)
  return statusOfMatter(m, t ? { status: 'running', phase: t.phase } : null, pending)
}

export type WaitingRow = { taskId: string; kind: 'permission' | 'question'; firstRequestId: string; count: number; fallback: string; matterTitle: string }

/** 「此刻」只回答一个问题:现在有什么要我管的(spec 2026-10-01 §5.2)。一起做的列表不在这里重复。 */
export function nowView(input: { approvals: ApprovalItemT[]; matters: MatterT[]; hour: number }): {
  greetingKey: 'now.greetingMorning' | 'now.greetingAfternoon' | 'now.greetingEvening'
  waiting: WaitingRow[]
} {
  const { approvals, matters, hour } = input
  const greetingKey = hour >= 5 && hour <= 11 ? 'now.greetingMorning' : hour >= 12 && hour <= 17 ? 'now.greetingAfternoon' : 'now.greetingEvening'
  const rows = new Map<string, WaitingRow>()
  for (const x of approvals) {
    const r = rows.get(x.taskId)
    if (r) { r.count++; if (x.kind === 'permission') r.kind = 'permission'; continue }
    rows.set(x.taskId, { taskId: x.taskId, kind: x.kind, firstRequestId: x.id, count: 1, fallback: x.summary, matterTitle: matters.find(m => m.id === x.taskId)?.title ?? '' })
  }
  return { greetingKey, waiting: [...rows.values()] }
}

/** CC 气泡:主人那条对话里最近一条 CC 说的话。没有就是 null —— 不画空气泡、不编客套话。 */
export function latestCCLine(page: ChatPageT | undefined): { text: string; at: number } | null {
  if (!page) return null
  for (let i = page.messages.length - 1; i >= 0; i--) {
    const m = page.messages[i]!
    if (m.role === 'cc' && m.text.trim() !== '') return { text: m.text.trim(), at: m.at }
  }
  return null
}
```

i18n(两份,键一致):新增 `now.waiting`(zh `{n} 件事等你` / en `{n} things waiting for you`)、`now.waiting.one`(zh `{n} 件事等你` / en `{n} thing waiting for you`)、`now.goLook`(`看清楚` / `Take a look`)、`now.goAnswer`(`回答` / `Answer`)、`now.ccBubble`(`CC 最近说的话,点开进对话` / `CC's latest words — open the chat`)、`now.openChat`(`跟 CC 说` / `Talk to CC`)。`CountKey` 加 `'now.waiting'`。删掉此刻页不再用、且 `grep -rn "<键>" apps/app/src` 无其他引用的键:`now.dateLine`、`now.needsYouEyebrow`、`now.needsYouSummaryMany`、`now.needsYouSummaryNone`、`now.ccWorking`、`now.ccIdle`、`now.needsYouCount`、`now.needsYouTitle`、`now.lookThenDecide`、`now.ccLine.default`、`now.togetherTitle`、`now.togetherCount(.one)`(后两个在 together 页还用就留)。

`apps/app/src/ui/SayBar.tsx`:

```tsx
import { Pressable, View } from 'react-native'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 底部「跟 CC 说一句…」:整条是一个按钮(点开进 /chat 写)。右端的圆钮只是这条按钮的一部分,不是另一个动作。
export function SayBar({ placeholder, onPress, testID }: { placeholder: string; onPress: () => void; testID?: string }) {
  const { c } = useTheme()
  return (
    <Pressable accessibilityRole="button" testID={testID} accessibilityLabel={placeholder} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: space.xl - 2, paddingRight: space.s, borderRadius: radius.control, borderWidth: 1, borderColor: pressed ? c.accent : c.hair, backgroundColor: c.paper })}>
      <Txt tone="inkSoft" style={{ flex: 1 }}>{placeholder}</Txt>
      <View importantForAccessibility="no" accessibilityElementsHidden style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Txt tone="onAccent" role="item">➤</Txt>
      </View>
    </Pressable>
  )
}
```

`apps/app/src/app/(tabs)/index.tsx` 整个替换为下面的结构(保留 `NeedsYouTitle` 的取说明标题逻辑,改名 `WaitingTitle`、改用 `Txt role="item" content="user"`):

```tsx
export default function Now() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, matters, demo } = useWork()
  const v = nowView({ approvals, matters, hour: new Date().getHours() })
  const chat = useQuery('chat:latest', () => backend.chat({}))   // 与 /chat 同一个键、同一份缓存
  const line = latestCCLine(chat.data)
  const presence = ccPresence(conn)
  const openChat = () => router.push('/chat')

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'common.wordmark')} onAvatar={() => router.push('/settings')}
        onConnection={() => router.push('/connections')} connectionTestID="now-connections" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.xxl }}>
        <RevokedNotice />{/* ConnectionNotice 只在 revoked 时出东西;离线信息已在顶栏 */}
        {demo ? <DemoBanner /> : null}
        <Txt role="display" accessibilityRole="header">{t(lang, v.greetingKey)}</Txt>
        <View style={{ alignItems: 'flex-end', gap: space.s }}>
          {line ? (
            <Pressable testID="now-cc-bubble" accessibilityRole="button" accessibilityLabel={`${t(lang, 'now.ccBubble')}: ${line.text}`} onPress={openChat}
              style={({ pressed }) => ({ maxWidth: 280, paddingHorizontal: space.l, paddingVertical: space.m, borderWidth: 1, borderColor: pressed ? c.accent : c.hair,
                borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble, borderBottomLeftRadius: radius.bubble, borderBottomRightRadius: 4 })}>
              <Txt role="bubble" content="user" numberOfLines={3}>{line.text}</Txt>
              <Txt role="caption" tone="inkSoft">{formatSynced(line.at, Date.now(), lang)}</Txt>
            </Pressable>
          ) : null}
          <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={openChat} style={{ marginRight: space.s }}>
            <CCFigure size={120} presence={presence} />
          </Pressable>
        </View>
        {v.waiting.length > 0 ? (
          <View>
            <Txt testID="now-waiting-title" role="meta" tone="inkSoft" style={{ marginBottom: space.s }}>{tCount(lang, 'now.waiting', v.waiting.length)}</Txt>
            <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
              {v.waiting.map((w, i) => (
                <View key={w.taskId} testID="now-needs-you-card">
                  <Pressable testID="now-look-then-decide" accessibilityRole="button" onPress={() => router.push(`/approval/${encodeURIComponent(w.taskId)}`)}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.l, minHeight: 64, paddingVertical: space.l, paddingHorizontal: space.xs, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <WaitingTitle taskId={w.taskId} requestId={w.firstRequestId} fallback={w.fallback} fetch={i === 0} />
                      {w.matterTitle ? <Txt role="meta" tone="inkSoft" content="user" numberOfLines={1}>{w.matterTitle}</Txt> : null}
                    </View>
                    <Txt role="bubble" tone="inkSoft">{t(lang, w.kind === 'permission' ? 'now.goLook' : 'now.goAnswer')} ›</Txt>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={openChat} />
      </View>
    </SafeAreaView>
  )
}
```

`RevokedNotice`:在 `ConnectionNotice.tsx` 里加一个导出 `ConnectionNotice({ only }: { only?: 'revoked' })`,`only === 'revoked'` 时非撤销态返回 null;此刻页用 `<ConnectionNotice only="revoked" />`(别处照旧)。同时把 `ConnectionNotice` 换成 `Txt`(从 NOT_YET_MIGRATED 删掉)。
`WaitingTitle` 的 `accessibilityLabel` 由外层 Pressable 的子元素自动合成;不另加。
删掉正文里 `now-connections-row` 那一行(Task 4 临时改名的)和 `now-together-item-*` 列表。

- [ ] **Step 4: 跑** `cd apps/app && bun run test && bun run typecheck` → PASS。

- [ ] **Step 5: Maestro**:逐个跑 `demo-walkthrough`、`approve`、`chat`、`connections`、`push-open`。`approve.yaml` 的 `tapOn: id: now-look-then-decide index: 0` 不用改;`connections.yaml` 的 `scrollUntilVisible now-connections` 可以留(顶栏本来可见)。新增断言到 `demo-walkthrough.yaml` 开头:

```yaml
- assertVisible:
    id: now-cc
- assertVisible:
    id: now-waiting-title
- assertNotVisible: ".*(慢慢来|take it slow).*"
```

`chat.yaml` 在 `tapOn: id: now-say` 之前加一段「点 CC 也能进对话」:`tapOn: id: now-cc` → `extendedWaitUntil chat-input` → `tapOn: id: topbar-back`。
Expected: 五个流全 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/app
git commit -m "手机此刻照稿重排:问候 + CC 气泡(最近一句真话,点开进对话)+「N 件事等你」行 + 底部说一句

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 手机组件与「一起做 / 对话 / 进展 / 批准」换皮

**Files:**
- Modify: `apps/app/src/ui/{Button,Card,StatusPill,TabBar,Sheet,DemoBanner,PushBanner,Placeholder,Dot}.tsx`、`apps/app/src/push/PushRouter.tsx`
- Modify: `apps/app/src/app/(tabs)/together.tsx`、`apps/app/src/app/chat.tsx`、`apps/app/src/app/matter/[id].tsx`、`apps/app/src/app/approval/[id].tsx`
- Modify: `apps/app/src/ui/style.guard.test.ts`(删这些文件;加「组件不嵌卡」用例)

**Interfaces:**
- Consumes: `Txt`、`TextField`、`palette`、`radius`、`space`。
- Produces: 组件对外属性不变(`Button({kind,label,onPress,disabled,busy,testID})`、`Card({children,style,testID})`、`StatusPill({status})`、`TabBar(BottomTabBarProps)`)。

换皮规则(每个文件照这张表做,不改结构 / testID / 文案):

| 旧 | 新 |
|---|---|
| `<Text style={{ color: c.ink, fontSize: 16, … }}>` | `<Txt role="body">`;字号 32/28 → `display`,20–22 → `title`,17–18 → `item`,16 → `body`,15 → `bubble`,14 → `meta`,13 → `small`,12 → `caption` |
| `color: c.muted` | `tone="inkSoft"` |
| `color: c.warn` 的**文字** | `tone="inkSoft"` + 前面加 `<Dot kind="warn" />`(状态色只上点) |
| `color: c.danger` 的文字(错误) | `tone="bad"` |
| 用户内容(事项标题、聊天正文、命令说明、文件名以外的正文) | 加 `content="user"` |
| 命令 / 路径 / diff(原 `fontFamily: monoFamily`) | `role="code"` |
| `<TextInput …>` | `<TextField …>`(保留 testID / ref / 回调) |
| `Card` 里再放 `Card` / 带底色的 `View` | 拆成同层,用 `hair` 细线分隔 |
| `backgroundColor: c.accentSoft` / `c.navOnBg` 的色块 | 删(没有色块) |

组件具体值:
- `Button`:主 = `backgroundColor: c.accent`、字 `Txt tone="onAccent" role="body"`;次 = 透明底 + `hair` 描边、字 `ink`;`borderRadius: radius.control`;`minHeight: 48`;按下 `opacity 0.85`;禁用 `0.55`。
- `Card`:`backgroundColor: c.paper`、`borderColor: c.hair`、`borderWidth: 1`、`borderRadius: radius.sheet`、`padding: space.l`;无阴影。
- `StatusPill`:去掉底块,只剩 `<Dot kind=… size={8} />` + `<Txt role="small" tone="inkSoft">`;映射 `waiting → warn`、`failed → bad`、`done|replied → ok`、`working|stopped → unknown`。
- `TabBar`:底 `c.rail`、顶边 `hair`;选中只把字变 `ink` 且 `role="body"`,未选中 `inkSoft`;不画色块。标签仍只有「此刻 / 一起做」(`(tabs)/_layout.tsx` 不动)。
- `Sheet`:遮罩 `c.scrim`,面板 `paper` + 顶部圆角 `radius.sheet`。
- `DemoBanner`/`PushBanner`/`Placeholder`:单层,`hair` 描边,无底色块。
- `Dot`:颜色映射不变(`ok/warn/bad/unknown` → 同名 token)。
- 删掉 `useTheme` 里的 `LegacyAliases`;本任务里 `c.bg/card/muted/line/primary/primaryInk/navOnBg/navOnInk/accentSoft/danger` 全部换成新键名(Task 7 的页面也要换 —— 先在本任务里对**所有**文件做 `c.旧键 → c.新键` 的机械替换,再删别名)。

- [ ] **Step 1: 失败的守卫用例**(追加到 `style.guard.test.ts`)

```ts
it('no legacy palette keys (bg/card/muted/line/primary/primaryInk/navOnBg/navOnInk/accentSoft/danger)', () => {
  for (const f of TSX) expect(readFileSync(f, 'utf8').match(/\bc\.(bg|card|muted|line|primary|primaryInk|navOnBg|navOnInk|accentSoft|danger)\b/g) ?? [], rel(f)).toEqual([])
})
it('status colours only on Dot (no ok/warn text colour)', () => {
  for (const f of TSX.filter(f => !f.endsWith('Dot.tsx'))) expect(readFileSync(f, 'utf8').match(/color:\s*c\.(ok|warn)\b|tone="(ok|warn)"/g) ?? [], rel(f)).toEqual([])
})
```

并从 `NOT_YET_MIGRATED` 删掉本任务的 13 个文件。

- [ ] **Step 2: 跑,确认失败**:`cd apps/app && bunx vitest run src/ui/style.guard.test.ts` → FAIL。

- [ ] **Step 3: 按上表逐文件改**(组件 → together → chat → matter → approval)。`approval/[id].tsx` 418 行:只换文字 / 颜色 / 卡片层级;「允许 / 拒绝」按钮沿用 `Button`(拒绝 = secondary,允许 = primary)。

- [ ] **Step 4: 跑** `cd apps/app && bun run test && bun run typecheck && bun run export:check` → PASS。

- [ ] **Step 5: Maestro**:`demo-walkthrough`、`approve`、`chat` → PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/app
git commit -m "手机换皮(一):组件、一起做、对话、进展、批准卡走 token 与衬线;状态只上点;去掉旧色板键

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 手机其余页换皮 + 删「加一张图」+ 设计截图流

**Files:**
- Modify: `apps/app/src/app/{compose,connections,settings,devices,pair,welcome,push-open,dev-push-key}.tsx`、`apps/app/src/app/sessions/{index,[key]}.tsx`
- Modify: `apps/app/src/i18n/{en,zh-Hans}.ts`(删 `compose.addImage`、`compose.noImage` 若无引用)
- Modify: `apps/app/.maestro/compose.yaml`
- Create: `apps/app/.maestro/design-shots.yaml`
- Modify: `apps/app/src/ui/style.guard.test.ts`(`NOT_YET_MIGRATED` 清空;加「没有未上线按钮」用例)

**Interfaces:**
- Consumes: Task 6 的组件与换皮表(同一张表,照做)。
- Produces: `NOT_YET_MIGRATED` 为空集。

- [ ] **Step 1: 失败的守卫用例**

```ts
it('every screen is migrated', () => { expect([...NOT_YET_MIGRATED]).toEqual([]) })
it('no buttons for unshipped features (image attach / mic)', () => {
  for (const f of TSX) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/compose-add-image|compose-image-note|testID="[^"]*mic[^"]*"/)
})
```

- [ ] **Step 2: 跑,确认失败。**

- [ ] **Step 3: 逐页换皮**(同 Task 6 的表)。`compose.tsx`:删「加一张图」`Pressable`、`note` 状态与 `compose-image-note` 文本;`compose.yaml` 删掉对应两步。`welcome.tsx` / `pair.tsx` 的 CC 用 `presence={ccPresence(conn)}`。`connections.tsx`:来源行 = 点 + 名称 + 文字,行间细线,不套卡。`settings.tsx`:分组靠留白与 `meta` 小标题,不套卡。

- [ ] **Step 4: 跑** `cd apps/app && bun run test && bun run typecheck && bun run export:check` → PASS。

- [ ] **Step 5: 设计截图流** `apps/app/.maestro/design-shots.yaml`

```yaml
# 设计验收出图(spec §7):演示模式,中文。不进 CI。英文版:在设置里切 English 后再跑一次(见计划 Step 6)。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- takeScreenshot: p01-welcome
- tapOn: { id: welcome-look-first }
- extendedWaitUntil: { visible: { id: now-cc }, timeout: 10000 }
- takeScreenshot: p02-now
- tapOn: { id: now-connections }
- extendedWaitUntil: { visible: { id: connections-computer-home }, timeout: 5000 }
- takeScreenshot: p03-connections
- tapOn: { id: topbar-back }
- tapOn: { id: now-cc }
- extendedWaitUntil: { visible: { id: chat-input }, timeout: 5000 }
- takeScreenshot: p04-chat
- tapOn: { id: topbar-back }
- tapOn: { id: now-look-then-decide, index: 0 }
- extendedWaitUntil: { visible: { id: approval-title }, timeout: 10000 }
- takeScreenshot: p05-approval
- tapOn: { id: topbar-back }
- tapOn: { id: tab-together }
- extendedWaitUntil: { visible: { id: together-item-a1b2c3d4 }, timeout: 5000 }
- takeScreenshot: p06-together
- tapOn: { id: together-item-a1b2c3d4 }
- extendedWaitUntil: { visible: { id: progress-status }, timeout: 10000 }
- takeScreenshot: p07-matter
- tapOn: { id: topbar-back }
- tapOn: { id: topbar-settings }
- extendedWaitUntil: { visible: { id: settings-language }, timeout: 5000 }
- takeScreenshot: p08-settings
```

(`_start.yaml`、各 testID 都已存在;若某个 id 在演示数据里不同,以 `demo-walkthrough.yaml` 为准改。)

- [ ] **Step 6: 出图**

```bash
OUT=~/Documents/tendhearth/cc-screens-2026-10-01-design/phone
mkdir -p "$OUT/zh" "$OUT/en"
cd apps/app && maestro test .maestro/design-shots.yaml --test-output-dir "$OUT/zh"
```

英文:模拟器系统语言设成 English(`xcrun simctl` 或设置 App),重装后同一条命令输出到 `$OUT/en`。全部 Maestro 流再跑一遍:`for f in .maestro/*.yaml; do maestro test "$f" || exit 1; done` → 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/app
git commit -m "手机换皮(二):交办 / 连接 / 会话 / 设置 / 配对 / 欢迎等页;删掉未上线的加图按钮;设计截图流

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase C — 桌面

### Task 8: 桌面 token / 衬线字 / 字重 / 无深色 + 样式守卫(含字面色值棘轮)

**Files:**
- Modify: `apps/desktop/src/index.html`(`<head>` 先引 `./tokens.css`、`./fonts.css`;`<title>` 改 `Tendhearth`)
- Create: `apps/desktop/src/fonts.css`
- Modify: `apps/desktop/src/styles.css`(删 Geist `@font-face`;`:root` 改别名;字重)、其余 `*.css`(字重)
- Create: `apps/desktop/src/design-style.test.ts`
- Create: `scripts/desktop-legacy-colors.ts`(一次性机械替换脚本,跑完入库留作记录)

**Interfaces:**
- Consumes: `apps/desktop/src/tokens.css` 的 `--th-*` 变量(Task 1);Task 2 的 woff2 文件名。
- Produces: 旧变量名(`--paper`、`--ink`、`--ink-2/3/4`、`--hair`、`--green*`、`--amber*`、`--rouge*`、`--sans`、`--cjk`、`--mono`、`--app-bg`、`--desktop`、`--tint`、`--paper-2/3`、`--hair-2`)继续可用,值指向 token;`HEX_BUDGET: Record<string, number>`(每个样式表允许的字面色值数,只许减)。

- [ ] **Step 1: 失败的守卫** `apps/desktop/src/design-style.test.ts`

```ts
// 桌面样式守卫(spec 2026-10-01 §6.1)。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = __dirname
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? (n === 'vendor' ? 0 : walk(f, out)) : out.push(f) }
  return out
}
const CSS = walk(ROOT).filter(f => f.endsWith('.css') && !f.endsWith('tokens.css'))
const rel = (f: string) => relative(ROOT, f)
const hexCount = (s: string) => (s.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) ?? []).length
/** 三块主界面零字面色值;其余按棘轮。Task 12 / 13 只许把数字往下改。 */
export const HEX_BUDGET: Record<string, number> = { /* Step 4 跑完后按实测填 */ }
const ZERO_HEX = ['styles/workbench.css', 'styles/workbench-attention.css', 'styles/task-entry.css', 'cc-life.css', 'cc-now.css']

describe('desktop design style', () => {
  it('no dark mode', () => { for (const f of CSS) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/prefers-color-scheme:\s*dark/) })
  it('font-weight is 400 / 500 / normal only', () => {
    for (const f of CSS) expect(readFileSync(f, 'utf8').match(/font-weight:\s*(?!400\b|500\b|normal\b|var\()[^;}\s]+/g) ?? [], rel(f)).toEqual([])
  })
  it('fonts are local; no runtime CDN', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    for (const s of [html, ...CSS.map(f => readFileSync(f, 'utf8'))]) expect(s).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(html.indexOf('tokens.css')).toBeGreaterThan(-1)
    expect(html.indexOf('tokens.css')).toBeLessThan(html.indexOf('styles.css'))
  })
  it('body text is serif', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8')
    expect(css).toMatch(/--sans:\s*var\(--th-font-serif\)/)
    expect(css).not.toMatch(/font-family:\s*"Geist"/)
  })
  it('literal colours: ratchet', () => {
    for (const f of CSS) {
      const r = rel(f)
      const budget = ZERO_HEX.includes(r) ? 0 : HEX_BUDGET[r]
      if (budget === undefined) continue
      expect(hexCount(readFileSync(f, 'utf8')), r).toBeLessThanOrEqual(budget)
    }
  })
})
```

(`ZERO_HEX` 里的文件在 Task 10 / 12 之前会超 —— 本任务先把 `ZERO_HEX` 写成空数组 `[]`,Task 10 加 `cc-life.css`、`cc-now.css`,Task 12 加工作台三份。)

- [ ] **Step 2: 跑,确认失败**:`bun --bun vitest run apps/desktop/src/design-style.test.ts` → FAIL(字重 85+ 处、Geist、`--sans` 不是衬线)。

- [ ] **Step 3: 实现**

`apps/desktop/src/fonts.css`:

```css
/* 本地衬线字体(spec 2026-10-01 §3)。西文交给 Source Serif 4,中文交给 Noto Serif SC;Geist Mono 只给代码。授权见 fonts/OFL.txt。 */
@font-face { font-family: "Source Serif 4"; font-weight: 400; font-display: swap; src: url("./fonts/source-serif-4-400.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212, U+2215; }
@font-face { font-family: "Source Serif 4"; font-weight: 500; font-display: swap; src: url("./fonts/source-serif-4-500.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212, U+2215; }
@font-face { font-family: "Noto Serif SC"; font-weight: 400; font-display: swap; src: url("./fonts/noto-serif-sc-400.woff2") format("woff2"); }
@font-face { font-family: "Noto Serif SC"; font-weight: 500; font-display: swap; src: url("./fonts/noto-serif-sc-500.woff2") format("woff2"); }
@font-face { font-family: "Geist Mono"; font-style: normal; font-weight: 400 500; font-display: swap; src: url("./fonts/geist-mono-variable-latin.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
b, strong { font-weight: 500; }
```

`styles.css`:删掉文件头两个 `@font-face`(搬进 `fonts.css`)与那段 Geist 注释,头注释改成「Tendhearth 暖纸 · 衬线 · 一个深绿(spec 2026-10-01)」;`:root` 改成:

```css
:root {
  --app-bg: var(--th-paper);
  --desktop: var(--th-ground);
  --paper: var(--th-paper);
  --paper-2: var(--th-rail);
  --paper-3: var(--th-rail);
  --tint: var(--th-paper);
  --ink: var(--th-ink);
  --ink-2: var(--th-ink);
  --ink-3: var(--th-ink-soft);
  --ink-4: var(--th-ink-soft);
  --hair: var(--th-hair);
  --hair-2: var(--th-hair);
  --green: var(--th-accent);
  --green-2: var(--th-accent);
  --green-soft: transparent;
  --green-ink: var(--th-accent);
  --amber: var(--th-warn);
  --amber-soft: transparent;
  --rouge: var(--th-bad);
  --rouge-soft: transparent;
  --sans: var(--th-font-serif);
  --cjk: var(--th-font-serif);
  --mono: var(--th-font-mono);
  --radius: var(--th-radius-bubble);
  --radius-sm: var(--th-radius-nav);
  --shadow: none;
  color-scheme: light;
}
body { font-size: var(--th-size-body); line-height: var(--th-lh-body); }
```

(注意:状态点的类(`.dot.ok/.warn/...`)若用 `--green`,本任务改为 `--th-ok`,让「深绿动作」与「绿点」分开:`grep -n "\.dot" apps/desktop/src/*.css` 逐个改;`::selection` 改 `background: var(--th-accent); color: var(--th-on-accent)`。)

字重:所有样式表 `font-weight: 600|700|800|bold|bolder` → `500`:

```bash
cd apps/desktop/src && for f in $(git ls-files '*.css' 'styles/*.css'); do sed -i '' -E 's/font-weight:[[:space:]]*(600|700|800|900|bold|bolder)/font-weight: 500/g' "$f"; done
```

`scripts/desktop-legacy-colors.ts`:把样式表里**等于旧 `:root` 色值**的字面量换成变量(只换精确匹配,其余不动):

```ts
// 一次性:旧色板字面量 → 变量(spec §6.1)。只换与旧 :root 完全相同的值,剩下的由 HEX_BUDGET 棘轮。
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
const MAP: Record<string, string> = {
  '#fef9ef': 'var(--th-paper)', '#d8d4c8': 'var(--th-ground)', '#fbfaf7': 'var(--th-paper)', '#f4f2ec': 'var(--th-rail)',
  '#ecebe4': 'var(--th-rail)', '#f6f9f4': 'var(--th-paper)', '#593f2c': 'var(--th-ink)', '#82807a': 'var(--th-ink-soft)',
  '#b3b1a8': 'var(--th-ink-soft)', '#e8e6df': 'var(--th-hair)', '#d8d5cb': 'var(--th-hair)', '#2f7a4d': 'var(--th-accent)',
  '#246239': 'var(--th-accent)', '#e6efe5': 'transparent', '#1b5635': 'var(--th-accent)', '#a4751c': 'var(--th-warn)',
  '#f6ecd3': 'transparent', '#b04832': 'var(--th-bad)', '#f4dcd3': 'transparent', '#ffffff': 'var(--th-paper)', '#fff': 'var(--th-paper)',
}
for (const f of globSync('apps/desktop/src/**/*.css')) {
  if (f.endsWith('tokens.css') || f.includes('/vendor/')) continue
  const src = readFileSync(f, 'utf8')
  const out = src.replace(/#[0-9a-fA-F]{6}\b|#[fF]{3}\b/g, m => MAP[m.toLowerCase()] ?? m)
  if (out !== src) { writeFileSync(f, out); console.log('rewrote', f) }
}
```

Run: `bun scripts/desktop-legacy-colors.ts`。`companion-window.css`、`animation-lab.css`(浮窗桌宠 / 动画实验室,spec §8 不在范围)跳过:脚本里加 `if (/companion-window|animation-lab/.test(f)) continue`。

- [ ] **Step 4: 填棘轮基线**

```bash
cd apps/desktop/src && for f in $(git ls-files '*.css' 'styles/*.css' | grep -v tokens.css); do printf "'%s': %s,\n" "$f" "$(grep -oE '#[0-9a-fA-F]{3,8}\b|rgba?\( *[0-9]' "$f" | wc -l | tr -d ' ')"; done
```

把输出原样贴进 `HEX_BUDGET`。

- [ ] **Step 5: 跑** `bun --bun vitest run apps/desktop/src` → PASS;`cd apps/desktop && bun x playwright test` → 全绿(纯换皮,不该有结构失败;若有用例断言了颜色 / 字体,改成断言 token 变量)。

- [ ] **Step 6: 目测**:`cd apps/desktop && bun run dev:mock`,浏览器开 `http://127.0.0.1:4176`,看此刻 / 工作台 / 回忆是衬线、暖纸、没粗体。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src scripts/desktop-legacy-colors.ts
git commit -m "桌面:接上 Tendhearth token、本地衬线字、只用 400/500 字重;旧色板字面量换变量 + 棘轮守卫

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 桌面「此刻」纯函数(问候 / CC 明暗 / 最近一句 / 等你的事 / 状态行)

**Files:**
- Create: `apps/desktop/src/modules/now-home.js`、`apps/desktop/src/modules/now-home.test.ts`
- Modify: `apps/desktop/src/view.js`(`daemonStatusLine` 文案)、`apps/desktop/src/view.test.ts`

**Interfaces:**
- Consumes: `Presence`(`presence-poller.js`,含 `presence: 'down'`)、`AttentionState`(`workbench-attention.js`:`{tasks: AttentionTask[], stale}`)、converse 消息 `{role: 'user'|'cc'|'error'|'system', text, at?, pending?}`。
- Produces(`now-home.js`,`// @ts-check` ESM):
  - `greetingFor(hour: number): '早上好' | '下午好' | '晚上好'`
  - `ccPresence(p: Presence | null): 'here' | 'away'`
  - `latestCCLine(messages: ConverseMsg[]): { text: string, at: number | null } | null`
  - `waitingRows(state: AttentionState | null): Array<{ id: string, title: string, detail: string, go: '看清楚' | '回答' }>`
  - `daemonStatusLine(daemon)`(view.js)改为 `{ cls: 'ok'|'bad', text: 'CC 在家 · 运行中' | 'CC 没在运行' }`

- [ ] **Step 1: 失败的测试** `apps/desktop/src/modules/now-home.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { greetingFor, ccPresence, latestCCLine, waitingRows } from './now-home.js'

describe('greetingFor', () => {
  it('三档,与手机同一套钟点', () => {
    expect(greetingFor(5)).toBe('早上好'); expect(greetingFor(11)).toBe('早上好')
    expect(greetingFor(12)).toBe('下午好'); expect(greetingFor(17)).toBe('下午好')
    expect(greetingFor(18)).toBe('晚上好'); expect(greetingFor(4)).toBe('晚上好')
  })
})
describe('ccPresence', () => {
  const p = (presence: string) => ({ presence, activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })
  it('拉到真数据就在身边(外发 offline 只影响微信,不变暗)', () => {
    for (const s of ['ok', 'degraded', 'offline']) expect(ccPresence(p(s))).toBe('here')
  })
  it('拉不到 / 还没拉 ⇒ 不在身边', () => { expect(ccPresence(p('down'))).toBe('away'); expect(ccPresence(null)).toBe('away') })
})
describe('latestCCLine', () => {
  it('最近一条 CC 的、非占位、非空的话', () => {
    expect(latestCCLine([{ role: 'cc', text: '早', at: 1 }, { role: 'user', text: '在吗', at: 2 }, { role: 'cc', text: '…', pending: true }, { role: 'cc', text: '行程好了', at: 3 }, { role: 'error', text: '失败' }] as any))
      .toEqual({ text: '行程好了', at: 3 })
  })
  it('只有占位 / 空 / 没有 ⇒ null', () => {
    expect(latestCCLine([])).toBeNull()
    expect(latestCCLine([{ role: 'cc', text: '…', pending: true }] as any)).toBeNull()
    expect(latestCCLine([{ role: 'user', text: 'hi' }] as any)).toBeNull()
  })
})
describe('waitingRows', () => {
  const task = (id: string, perm: number, q: number) => ({ id, title: `任务 ${id}`, providerId: 'claude', pendingPermissionCount: perm, pendingQuestionCount: q, attentionKey: '[]' })
  it('有权限 ⇒ 看清楚;只有问题 ⇒ 回答;说明是计数', () => {
    expect(waitingRows({ tasks: [task('a', 1, 1), task('b', 0, 2)], stale: false })).toEqual([
      { id: 'a', title: '任务 a', detail: '1 项权限 · 1 个问题', go: '看清楚' },
      { id: 'b', title: '任务 b', detail: '2 个问题', go: '回答' },
    ])
  })
  it('读不到 / 过期 ⇒ 空(不显示旧的「等你」)', () => {
    expect(waitingRows(null)).toEqual([])
    expect(waitingRows({ tasks: [task('a', 1, 0)], stale: true })).toEqual([])
  })
})
```

`view.test.ts` 里 `daemonStatusLine` 的用例改成:`{alive:true,pid:1}` ⇒ `{cls:'ok',text:'CC 在家 · 运行中'}`;`{alive:false}` ⇒ `{cls:'bad',text:'CC 没在运行'}`(没跑 = 没连上 = 红,不默认绿)。

- [ ] **Step 2: 跑,确认失败**:`bun --bun vitest run apps/desktop/src/modules/now-home.test.ts apps/desktop/src/view.test.ts` → FAIL。

- [ ] **Step 3: 实现** `apps/desktop/src/modules/now-home.js`

```js
// @ts-check
// now-home.js — 「此刻」页的纯函数(spec 2026-10-01 §6.3)。无 DOM。

/** @param {number} hour */
export function greetingFor(hour) {
  return hour >= 5 && hour <= 11 ? '早上好' : hour >= 12 && hour <= 17 ? '下午好' : '晚上好'
}

/** 够得着 daemon 就在身边;presence.offline 指微信外发,不变暗。@param {{presence:string}|null} p */
export function ccPresence(p) {
  return p && p.presence !== 'down' ? 'here' : 'away'
}

/** @param {Array<{role:string,text:string,at?:number,pending?:boolean}>} messages */
export function latestCCLine(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'cc' && !m.pending && m.text.trim() !== '') return { text: m.text.trim(), at: typeof m.at === 'number' ? m.at : null }
  }
  return null
}

/** @param {{tasks:Array<{id:string,title:string,pendingPermissionCount:number,pendingQuestionCount:number}>,stale:boolean}|null} state */
export function waitingRows(state) {
  if (!state || state.stale) return []
  return state.tasks.map(t => ({
    id: t.id,
    title: t.title,
    detail: [t.pendingPermissionCount ? `${t.pendingPermissionCount} 项权限` : '', t.pendingQuestionCount ? `${t.pendingQuestionCount} 个问题` : ''].filter(Boolean).join(' · '),
    go: /** @type {'看清楚'|'回答'} */ (t.pendingPermissionCount > 0 ? '看清楚' : '回答'),
  }))
}
```

`view.js`:

```js
export function daemonStatusLine(daemon) {
  return daemon.alive ? { cls: "ok", text: "CC 在家 · 运行中" } : { cls: "bad", text: "CC 没在运行" }
}
```

并确认 `.dot.bad` 样式存在(`grep -n "\.dot\.\(ok\|warn\|bad\)" apps/desktop/src/styles.css`;没有 `.bad` 就加 `.dot.bad { background: var(--th-bad) }`,`.dot` 默认 `background: var(--th-unknown)`)。

- [ ] **Step 4: 跑** → PASS;`bun run typecheck`(桌面 JS 有 `@ts-check`)→ 0。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/modules/now-home.js apps/desktop/src/modules/now-home.test.ts apps/desktop/src/view.js apps/desktop/src/view.test.ts apps/desktop/src/styles.css
git commit -m "桌面此刻纯函数:问候 / CC 明暗(够得着=Light)/ 最近一句 / 等你的事 / 状态行不默认绿

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 桌面「此刻」照稿重排(home / chat 两态、连接面板、气泡入口)

**Files:**
- Modify: `apps/desktop/src/index.html`(overview pane 结构)
- Create: `apps/desktop/src/cc-now.css`(此刻页样式,零字面色值);`index.html` 引用它
- Modify: `apps/desktop/src/cc-life.css`(删 `.cc-current-activity` / `.cc-now-scene` / `.cc-life-topline` 等此刻旧样式,剩余零字面色值)
- Create: `apps/desktop/src/modules/now-page.js`(挂载与 DOM;调用 Task 9 的纯函数)
- Create: `apps/desktop/src/modules/now-page.test.ts`(happy-dom,新增根 devDependency)
- Modify: `package.json`、`bun.lock`(`happy-dom` devDependency)
- Modify: `apps/desktop/src/modules/converse.js`(消息带 `at`;`subscribeConverse`;home 只露输入框与发送)
- Modify: `apps/desktop/src/main.js`(挂 now-page;`switchPane('converse')` ⇒ chat 态;`body.dataset.pane`;attention 喂 now-page)
- Modify: `apps/desktop/src/modules/cc-life.js`、`cc-life.test.ts`(删 `mountCurrentActivity`;`currentActivity` 若无引用一起删)
- Modify: `apps/desktop/test-shim.ts`(`demo.seed { presenceDown: true }` ⇒ presence 503)
- Modify: `apps/desktop/playwright/dashboard.spec.ts`(结构变动处)
- Modify: `apps/desktop/src/design-style.test.ts`(`ZERO_HEX` 加 `cc-life.css`、`cc-now.css`)

**Interfaces:**
- Consumes: `greetingFor`、`ccPresence`、`latestCCLine`、`waitingRows`(Task 9);`presencePoller.subscribe`;`mountWorkbenchAttention({onChange})`;`openWorkbenchTask(id)`;`switchPane`。
- Produces:
  - `converse.js`:`export function subscribeConverse(cb: (msgs: ConverseMsg[]) => void): () => void`(订阅即回放当前);`ConverseMsg` 加 `at?: number`;`export function setConverseMode(mode: 'home' | 'chat'): void`(切 `#converse-root[data-mode]`)
  - `now-page.js`:`export function mountNowPage({ root, presencePoller, onOpenTask, onModeChange?: (m: 'home'|'chat') => void, now?: () => Date }): { setAttention(state: AttentionState | null): void, setLatestLine(line: { text: string, at: number | null } | null): void, setMode(mode: 'home'|'chat'): void, destroy(): void }`
  - DOM:`article.cc-now-pane[data-now="home"|"chat"]`;`#now-greeting`;`#now-cc-bubble`(button);`#now-cc`(button,内含 `img.now-cc-light` / `img.now-cc-dark`,`data-cc="here"|"away"` 在 pane 上);`#now-waiting`(section)+ `#now-waiting-title` + `ul#now-waiting-list > li > button.now-waiting-row[data-task-id]`;`#now-back`(chat 态返回);`.cc-home-details > summary` 内含 `#dash-rail-dot`、`#dash-rail-text`

新的 overview pane 结构(替换 `index.html` 里从 `<article class="dash-pane cc-now-pane"` 到它的 `</article>` 之间的**外层**;`<details class="cc-home-details">` 内部 `.moment-body` 原样保留,只换 summary):

```html
<article class="dash-pane cc-now-pane" data-pane="overview" data-now="home" data-cc="away">
  <details class="cc-home-details">
    <summary aria-label="CC 的连接"><span id="dash-rail-dot" class="dot"></span><span id="dash-rail-text">未运行</span></summary>
    <!-- .moment-body … 原样 -->
  </details>
  <button id="now-back" class="now-back" type="button" hidden>‹ 此刻</button>
  <section class="now-hero">
    <h1 id="now-greeting" class="now-greeting">晚上好</h1>
    <div class="now-cc-col">
      <button id="now-cc-bubble" class="now-bubble" type="button" hidden aria-label="CC 最近说的话，点开进对话"><span class="now-bubble-text"></span><small class="now-bubble-time"></small></button>
      <button id="now-cc" class="now-figure" type="button" aria-label="跟 CC 说">
        <img class="now-cc-light" src="./assets/pet/cc-v1/canonical/lit/front.png" alt="" />
        <img class="now-cc-dark" src="./assets/pet/cc-v1/canonical/unlit/front.png" alt="" />
      </button>
    </div>
  </section>
  <section id="now-waiting" class="now-waiting" aria-labelledby="now-waiting-title" hidden>
    <h2 id="now-waiting-title"></h2>
    <ul id="now-waiting-list"></ul>
  </section>
  <div id="converse-root" class="converse-page"></div>
</article>
```

删掉:`<header class="cc-life-topline">`、`#cc-current-activity`、侧栏 `.dash-rail-foot`(它的两个 id 已搬进 summary;`#dash-rail-clock` 删,`grep -n "dash-rail-clock" apps/desktop/src` 把写它的代码一起删)。

`cc-now.css`(只用 token 变量):

```css
.cc-now-pane { display: flex; flex-direction: column; gap: var(--th-space-xxl); padding: 22px 48px 32px; min-height: 100%; position: relative; }
.cc-home-details { position: absolute; top: 18px; right: 48px; z-index: 5; }
.cc-home-details > summary { list-style: none; display: flex; gap: 8px; align-items: center; font-size: var(--th-size-small); color: var(--th-ink-soft); cursor: pointer; padding: 6px 0; }
.cc-home-details > summary::-webkit-details-marker { display: none; }
.cc-home-details > summary:focus-visible { outline: 2px solid var(--th-accent); outline-offset: 2px; }
.cc-home-details[open] > .moment-body { position: absolute; right: 0; top: 32px; width: min(720px, calc(100vw - 280px)); max-height: 70vh; overflow: auto; background: var(--th-paper); border: 1px solid var(--th-hair); border-radius: var(--th-radius-sheet); padding: var(--th-space-xl); }
.now-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: var(--th-space-xl); margin-top: 28px; }
.now-greeting { font-size: var(--th-size-display); line-height: var(--th-lh-display); font-weight: 400; margin: 0; }
.now-cc-col { display: grid; justify-items: end; gap: 6px; }
.now-bubble { border: 1px solid var(--th-hair); background: var(--th-paper); color: var(--th-ink); font-size: var(--th-size-bubble); line-height: var(--th-lh-bubble); text-align: left; padding: 12px 16px; border-radius: 14px 14px 4px 14px; max-width: 280px; cursor: pointer; }
.now-bubble:hover, .now-bubble:focus-visible { border-color: var(--th-accent); outline: none; }
.now-bubble .now-bubble-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.now-bubble small { display: block; color: var(--th-ink-soft); font-size: var(--th-size-caption); margin-top: 4px; }
.now-figure { width: 150px; height: 150px; position: relative; margin-right: 8px; }
.now-figure::before { content: ""; position: absolute; inset: 18% 8% 0; background: radial-gradient(closest-side, var(--th-glow), transparent); transition: opacity .6s; }
.now-figure img { position: relative; width: 100%; height: 100%; }
.cc-now-pane[data-cc="here"] .now-cc-dark, .cc-now-pane[data-cc="away"] .now-cc-light { display: none; }
.cc-now-pane[data-cc="away"] .now-figure::before { opacity: 0; }
.now-waiting h2 { font-size: var(--th-size-meta); font-weight: 500; color: var(--th-ink-soft); margin: 0 0 6px; letter-spacing: var(--th-tracking-meta); }
.now-waiting ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--th-hair); }
.now-waiting-row { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 16px 4px; border-bottom: 1px solid var(--th-hair); text-align: left; }
.now-waiting-row .t { font-size: var(--th-size-item); margin: 0; }
.now-waiting-row .d { font-size: var(--th-size-meta); color: var(--th-ink-soft); margin: 2px 0 0; }
.now-waiting-row .go { color: var(--th-ink-soft); font-size: var(--th-size-bubble); }
.now-waiting-row:hover .t, .now-waiting-row:focus-visible .t { color: var(--th-accent); }
.now-back { align-self: flex-start; color: var(--th-ink-soft); font-size: var(--th-size-meta); }
/* home:对话记录收起,composer 只露输入框 + 发送 */
.cc-now-pane[data-now="home"] #converse-scroll,
.cc-now-pane[data-now="home"] .converse-toolbar > :not(#converse-send) { display: none; }
.cc-now-pane[data-now="home"] #converse-root { margin-top: auto; }
.cc-now-pane[data-now="chat"] .now-hero, .cc-now-pane[data-now="chat"] .now-waiting { display: none; }
.cc-now-pane[data-now="chat"] #converse-root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.converse-compose { display: flex; gap: 10px; align-items: center; border: 1px solid var(--th-hair); border-radius: var(--th-radius-control); padding: 8px 8px 8px 22px; }
#converse-send { width: 40px; height: 40px; border-radius: 50%; background: var(--th-accent); color: var(--th-on-accent); }
body[data-pane="overview"] #workbench-attention { display: none !important; }
@media (max-width: 760px) {
  .cc-now-pane { padding: 8px 18px 20px; gap: 28px; }
  .now-hero { grid-template-columns: 1fr; }
  .now-figure { width: 120px; height: 120px; }
  .cc-home-details { right: 18px; }
}
@media (prefers-reduced-motion: no-preference) {
  .cc-now-pane[data-cc="here"] .now-figure img { animation: now-breathe 6s ease-in-out infinite; transform-origin: 50% 90%; }
  @keyframes now-breathe { 50% { transform: scaleY(1.015) translateY(-1px); } }
}
```

(`#converse-send` 现在里面是「图标 + 发送」两个子元素 —— home 态把文字 `span` 视觉隐藏:`.cc-now-pane[data-now="home"] #converse-send span { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0) }`;图标留着。aria-label「发送消息」不变。)

- [ ] **Step 1: 失败的测试** `apps/desktop/src/modules/now-page.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mountNowPage } from './now-page.js'

function dom() {
  document.body.innerHTML = `<article class="cc-now-pane" data-now="home" data-cc="away">
    <button id="now-back" hidden></button><h1 id="now-greeting"></h1>
    <button id="now-cc-bubble" hidden><span class="now-bubble-text"></span><small class="now-bubble-time"></small></button>
    <button id="now-cc"></button>
    <section id="now-waiting" hidden><h2 id="now-waiting-title"></h2><ul id="now-waiting-list"></ul></section>
    <div id="converse-root"></div></article>`
  return document.querySelector('.cc-now-pane') as HTMLElement
}
const poller = () => { let cb: any; return { subscribe: (f: any) => { cb = f; return () => {} }, push: (p: any) => cb(p) } }

describe('mountNowPage', () => {
  it('greets by hour and flips CC by presence', () => {
    const root = dom(); const pp = poller()
    mountNowPage({ root, presencePoller: pp, onOpenTask: vi.fn(), now: () => new Date(2026, 9, 1, 21) })
    expect(document.getElementById('now-greeting')!.textContent).toBe('晚上好')
    expect(root.dataset.cc).toBe('away')
    pp.push({ presence: 'ok' }); expect(root.dataset.cc).toBe('here')
    pp.push({ presence: 'down' }); expect(root.dataset.cc).toBe('away')
  })
  it('waiting rows: count title, whole row opens the task, hidden when empty', () => {
    const root = dom(); const open = vi.fn()
    const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: open })
    page.setAttention({ stale: false, tasks: [{ id: 'a', title: '作品集', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    expect(document.getElementById('now-waiting')!.hidden).toBe(false)
    expect(document.getElementById('now-waiting-title')!.textContent).toBe('1 件事等你')
    ;(document.querySelector('.now-waiting-row') as HTMLElement).click()
    expect(open).toHaveBeenCalledWith('a')
    page.setAttention({ stale: false, tasks: [] }); expect(document.getElementById('now-waiting')!.hidden).toBe(true)
  })
  it('escapes task titles', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setAttention({ stale: false, tasks: [{ id: 'x', title: '<img src=x onerror=1>', providerId: 'c', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["r"]' }] } as any)
    expect(document.querySelector('#now-waiting-list img')).toBeNull()
  })
  it('bubble shows the latest real CC line, and bubble / CC open chat mode', () => {
    const root = dom(); const page = mountNowPage({ root, presencePoller: poller(), onOpenTask: vi.fn() })
    page.setLatestLine({ text: '行程好了', at: new Date(2026, 9, 1, 20, 34).getTime() })
    expect(document.getElementById('now-cc-bubble')!.hidden).toBe(false)
    expect(document.querySelector('.now-bubble-time')!.textContent).toBe('20:34')
    ;(document.getElementById('now-cc-bubble') as HTMLElement).click()
    expect(root.dataset.now).toBe('chat'); expect(document.getElementById('now-back')!.hidden).toBe(false)
    ;(document.getElementById('now-back') as HTMLElement).click(); expect(root.dataset.now).toBe('home')
    ;(document.getElementById('now-cc') as HTMLElement).click(); expect(root.dataset.now).toBe('chat')
    page.setLatestLine(null); expect(document.getElementById('now-cc-bubble')!.hidden).toBe(true)
  })
})
```

(时间格式:同一天 `HH:MM`,否则 `M月D日 HH:MM`;`at === null` 不显示时间。仓库目前没有 DOM 测试环境:本步先 `bun add -d happy-dom`(根 `package.json` devDependencies,锁进 `bun.lock`),用文件头的 `// @vitest-environment happy-dom` 只给这一个文件开 DOM;`npm run test:node` 也要过。)

- [ ] **Step 2: 跑,确认失败。**

- [ ] **Step 3: 实现** `now-page.js`(用 Task 9 的纯函数;`textContent` 写字,不拼 HTML;行用 `document.createElement`):

```js
// @ts-check
// now-page.js — 「此刻」页(spec 2026-10-01 §6.3):问候、CC(明暗来自 presence)、最近一句真话的气泡、等你的事、home/chat 两态。
import { greetingFor, ccPresence, waitingRows } from './now-home.js'

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
/** @param {number} at @param {Date} now */
function when(at, now) {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** @param {{root:HTMLElement,presencePoller:{subscribe:(cb:(p:any)=>void)=>()=>void},onOpenTask:(id:string)=>unknown,onModeChange?:(m:'home'|'chat')=>void,now?:()=>Date}} o */
export function mountNowPage({ root, presencePoller, onOpenTask, onModeChange, now = () => new Date() }) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`))
  $('now-greeting').textContent = greetingFor(now().getHours())
  const unsub = presencePoller.subscribe(p => { root.dataset.cc = ccPresence(p) })
  /** @param {'home'|'chat'} m */
  function setMode(m) { root.dataset.now = m; $('now-back').hidden = m !== 'chat'; onModeChange?.(m) }
  const toChat = () => setMode('chat')
  $('now-cc-bubble').addEventListener('click', toChat)
  $('now-cc').addEventListener('click', toChat)
  $('now-back').addEventListener('click', () => setMode('home'))
  const list = $('now-waiting-list')
  list.addEventListener('click', e => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.now-waiting-row'))
    if (row?.dataset.taskId) void onOpenTask(row.dataset.taskId)
  })
  return {
    setMode,
    /** @param {{text:string,at:number|null}|null} line */
    setLatestLine(line) {
      const b = $('now-cc-bubble')
      b.hidden = !line
      if (!line) return
      /** @type {HTMLElement} */ (b.querySelector('.now-bubble-text')).textContent = line.text
      /** @type {HTMLElement} */ (b.querySelector('.now-bubble-time')).textContent = line.at === null ? '' : when(line.at, now())
    },
    /** @param {any} state */
    setAttention(state) {
      const rows = waitingRows(state)
      $('now-waiting').hidden = rows.length === 0
      $('now-waiting-title').textContent = `${rows.length} 件事等你`
      list.replaceChildren(...rows.map(r => {
        const li = document.createElement('li')
        const btn = document.createElement('button')
        btn.type = 'button'; btn.className = 'now-waiting-row'; btn.dataset.taskId = r.id
        const text = document.createElement('div')
        const t = document.createElement('p'); t.className = 't'; t.textContent = r.title
        const d = document.createElement('p'); d.className = 'd'; d.textContent = r.detail
        text.append(t, d)
        const go = document.createElement('span'); go.className = 'go'; go.textContent = `${r.go} ›`
        btn.append(text, go); li.append(btn); return li
      }))
    },
    destroy() { unsub() },
  }
}
```

`converse.js`:
- `ConverseMsg` 加 `at?: number`;`loadSharedHistory` 里 `at: e.createdAt`;`sendMessage` 里用户消息 `at: Date.now()`,CC 回复落地时 `at: Date.now()`。
- 加模块级 `const listeners = new Set()`;`renderMessages()` 末尾 `for (const cb of listeners) cb(messages)`;`export function subscribeConverse(cb) { listeners.add(cb); cb(messages); return () => listeners.delete(cb) }`。
- `sendMessage` 开头调 `onSend?.()`(新 `Deps` 字段 `onSend?: () => void`),main.js 用它把此刻切到 chat 态。

`main.js`:
- 删 `mountCurrentActivity` 那两行与 import;加
  ```js
  import { mountNowPage } from "./modules/now-page.js"
  import { subscribeConverse } from "./modules/converse.js"
  import { latestCCLine } from "./modules/now-home.js"
  const nowRoot = /** @type {HTMLElement|null} */ (document.querySelector('.cc-now-pane'))
  const nowPage = nowRoot ? mountNowPage({ root: nowRoot, presencePoller, onOpenTask: async id => { switchPane('workbench'); await openWorkbenchTask(id) },
    onModeChange: m => { if (m === 'chat') document.getElementById('converse-input')?.focus() } }) : null
  subscribeConverse(msgs => nowPage?.setLatestLine(latestCCLine(msgs)))
  ```
- `mountWorkbenchAttention` 的 `onChange` 改成 `snapshot => { careSheet.setAttention(snapshot); nowPage?.setAttention(snapshot) }`。
- `switchPane`:开头 `document.body.dataset.pane = name === 'converse' ? 'overview' : name`;`focusConversation` 分支里加 `nowPage?.setMode('chat')`;切到 overview 但不是 converse 时 `nowPage?.setMode('home')`。
- `deps.onSend = () => nowPage?.setMode('chat')`。
- 启动时 `initConversePage(deps, { focus: false })`(第 1477 行已有)保证 home 态也拉了历史,气泡有内容。
- `careSheet` 仍挂(attention 在喂它),但此刻页不再有打开它的入口(spec §6.3);`cc-life.js` 删 `mountCurrentActivity`(与 `currentActivity`,若 `grep -rn "currentActivity" apps/desktop/src` 只剩 cc-care.js 用 ⇒ 留 `currentActivity`),`cc-life.test.ts` 删对应三条用例。

`test-shim.ts`:`demo.seed` 读 `presenceDown?: boolean` 存进 `__mockState.presenceDown`;presence 路由里 `if (__mockState.presenceDown) return Response.json({ error: 'journal_not_wired' }, { status: 503 })`。

Playwright `dashboard.spec.ts`(只改结构变了的地方):
- 「dashboard renders nav + panes」:`button[data-pane="converse"]` 那行改成 `await expect(page.locator('#now-cc')).toBeAttached()`(Task 11 才删侧栏按钮,本任务先改断言也成立)。
- 「presence shell keeps one home composer…」:`clickNav(page, 'converse')` 那段保留(Task 11 前侧栏按钮还在);加断言 `await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-now', 'chat')`;rail 尺寸断言不动。
- 新用例(Review Focus 第 5 条):

```ts
test('此刻 home → chat via the CC, draft survives a workbench round-trip, one converse root', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  const pane = page.locator('.cc-now-pane')
  await expect(pane).toHaveAttribute('data-now', 'home')
  await expect(page.locator('#converse-scroll')).toBeHidden()
  await page.locator('#converse-input').fill('草稿不丢')
  await page.locator('#now-cc').click()
  await expect(pane).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#converse-scroll')).toBeVisible()
  await clickNav(page, 'workbench')
  await clickNav(page, 'overview')
  await expect(page.locator('#converse-input')).toHaveValue('草稿不丢')
  await expect(page.locator('#converse-root')).toHaveCount(1)
  await page.locator('#now-back').click()
  await expect(pane).toHaveAttribute('data-now', 'home')
})
test('CC goes dark when the daemon cannot be reached', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', presenceDown: true })
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'away', { timeout: 25_000 })
  await expect(page.locator('.now-cc-light')).toBeHidden()
})
```

`design-style.test.ts`:`ZERO_HEX` 加 `'cc-life.css'`、`'cc-now.css'`(`cc-life.css` 剩下的回忆 / 记忆样式里的字面色值本任务一起换成 token;它是此刻 + 回忆共用的文件)。

- [ ] **Step 4: 跑** `bun --bun vitest run apps/desktop/src && bun run typecheck` → PASS;`cd apps/desktop && bun x playwright test` → 全绿(`overview.spec.ts` 那些 `#hero-headline`、`#dash-restart` 用例靠 `reveal()` 打开 `.cc-home-details`,结构未变应照旧过;若某条因面板改成浮层而 `toBeVisible` 失败,查是不是被 `overflow`/`max-height` 裁掉,修 CSS 不改断言)。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "桌面此刻照稿重排:问候 + CC(真实明暗)+ 最近一句气泡做对话入口 + 等你的事 + home/chat 两态 + 状态行做连接入口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 桌面侧栏只放导航

**Files:**
- Modify: `apps/desktop/src/index.html`(`#dash-global-rail`)、`apps/desktop/src/styles.css`(`.dash-rail*` 样式)
- Modify: `apps/desktop/src/modules/settings-drawer.js` 或设置抽屉 HTML(「关于」加版本行,读已有的版本来源 —— `grep -rn "app_version\|getVersion" apps/desktop/src` 找现有取法;找不到就不加,删掉写死的 `v0.6.2` 即可)
- Modify: `apps/desktop/playwright/dashboard.spec.ts`(converse 入口断言)
- Create: `apps/desktop/src/rail.test.ts`

**Interfaces:**
- Consumes: 现有 `switchPane`、`clickNav`(`.cc-life-nav-more` 展开)。
- Produces: 侧栏 DOM —— `p.dash-wordmark`「tendhearth」;`nav.dash-nav` 内 `button.dash-nav-link[data-pane]` × 3(overview / workbench / recollections);`details.cc-life-nav-more > summary`「更多」内 5 个 `button.dash-nav-link`(atelier / memory / todos / a2a-agents / sessions[data-backstage-entry]);`#settings-open`「设置」。无图标、无标语、无版本号、无「跟 CC 说」按钮。

- [ ] **Step 1: 失败的测试** `apps/desktop/src/rail.test.ts`

```ts
// 侧栏只放导航(spec 2026-10-01 §6.2)。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const rail = html.slice(html.indexOf('id="dash-global-rail"'), html.indexOf('</aside>', html.indexOf('id="dash-global-rail"')))

describe('desktop rail', () => {
  it('has the wordmark and nav only', () => {
    expect(rail).toContain('tendhearth')
    expect(rail).not.toMatch(/一起生活|cc-brand-note|dash-version|data-hg-icon|dash-rail-foot/)
  })
  it('keeps every pane reachable and the e2e hooks', () => {
    for (const p of ['overview', 'workbench', 'recollections', 'atelier', 'memory', 'todos', 'a2a-agents', 'sessions']) expect(rail).toContain(`data-pane="${p}"`)
    expect(rail).toContain('cc-life-nav-more')
    expect(rail).toContain('id="settings-open"')
  })
  it('the CC bubble is the chat entry; no separate 跟 CC 说 nav', () => {
    expect(rail).not.toContain('data-pane="converse"')
  })
})
```

- [ ] **Step 2: 跑,确认失败。**

- [ ] **Step 3: 实现** —— `#dash-global-rail` 内容替换为:

```html
<aside id="dash-global-rail" class="dash-rail">
  <p class="dash-wordmark">tendhearth</p>
  <nav class="dash-nav" aria-label="主导航">
    <button class="dash-nav-link active" data-pane="overview">此刻</button>
    <button class="dash-nav-link" data-pane="workbench">一起做</button>
    <button class="dash-nav-link" data-pane="recollections">回忆</button>
  </nav>
  <details class="cc-life-nav-more">
    <summary>更多</summary>
    <div>
      <button class="dash-nav-link" data-pane="atelier">画室</button>
      <button class="dash-nav-link" data-pane="memory">记忆<span class="count" id="memory-count"></span></button>
      <button class="dash-nav-link" data-pane="todos">待办</button>
      <button class="dash-nav-link" data-pane="a2a-agents">觅食</button>
      <button class="dash-nav-link" data-pane="sessions" data-backstage-entry="true">后厨<span class="count" id="sessions-count"></span></button>
    </div>
  </details>
  <div class="dash-utilities"><button id="settings-open" class="rail-gear" type="button">设置</button></div>
</aside>
```

`styles.css` 的侧栏样式(照稿):`.dash-rail { background: var(--th-rail); padding: 22px 18px; display: flex; flex-direction: column; gap: 28px; }`、`.dash-wordmark { font-size: var(--th-size-wordmark); font-weight: 500; margin: 0; }`、`.dash-nav-link { display: block; padding: 9px 12px; border-radius: var(--th-radius-nav); color: var(--th-ink-soft); font-size: var(--th-size-body); text-align: left; }`、`.dash-nav-link.active { color: var(--th-ink); background: var(--th-paper); }`、`.dash-utilities { margin-top: auto; }`、`.rail-gear { color: var(--th-ink-soft); font-size: var(--th-size-meta); padding: 9px 12px; }`;删掉 `.cc-brand-*`、`.dash-brand`、`.ver`、`.dash-rail-foot`、`.rail-gear .ic` 等不再存在的选择器(`grep` 确认没有别处用)。`.count` 数字用 `inkSoft`,不画彩色小圆。
`grep -rn 'data-pane="converse"\|\[data-pane=.converse.\]' apps/desktop/src --include='*.js'`:代码里调 `switchPane('converse')` 的地方保留(走 Task 10 的 chat 态),只是没有侧栏按钮了。

Playwright:`dashboard.spec.ts`「presence shell…」里 `await page.locator('.cc-life-nav-more > summary').click(); await clickNav(page, 'converse')` 两行改成 `await clickNav(page, 'overview'); await page.locator('#now-cc').click()`,其后断言(草稿在、聚焦、`#converse-root` 一份、rail 尺寸)不变。`overview.spec.ts` 第 72/85 行若断言 `.cc-life-nav-more > summary` 文案「生活与工具」⇒ 改「更多」。

- [ ] **Step 4: 跑** `bun --bun vitest run apps/desktop/src` 与 `cd apps/desktop && bun x playwright test` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "桌面侧栏只放导航:tendhearth + 此刻/一起做/回忆 + 更多 + 设置;去掉标语、图标、写死的版本号与重复的对话入口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 桌面「一起做」与「跟 CC 说」换皮(零字面色值、状态只上点)

**Files:**
- Modify: `apps/desktop/src/styles/workbench.css`、`styles/workbench-attention.css`、`styles/task-entry.css`
- Modify: `apps/desktop/src/styles.css` 里 `.converse-*`、`.dialogue-*` 段
- Modify: 工作台状态签的渲染处(`grep -n "status-chip\|wb-status\|chip" apps/desktop/src/modules/workbench*.js` 找到生成状态签的函数)
- Modify: `apps/desktop/src/design-style.test.ts`(`ZERO_HEX` 加三份)

**Interfaces:**
- Consumes: `--th-*` token;Task 8 的旧变量别名。
- Produces: 工作台状态签 DOM 变成 `<span class="wb-state"><i class="dot {ok|warn|bad|unknown}"></i>文字</span>`(类名以实际函数为准,但必须是「点 + 文字」、无底色块)。若有 e2e / 单测按旧类名找状态签,保留旧类名、只改样式。

- [ ] **Step 1: 失败的守卫**:`ZERO_HEX` 加 `'styles/workbench.css', 'styles/workbench-attention.css', 'styles/task-entry.css'`;再加一条:

```ts
it('workbench status chips are dot + text (no tinted chip backgrounds)', () => {
  const css = readFileSync(join(ROOT, 'styles/workbench.css'), 'utf8')
  expect(css.match(/background(-color)?:\s*var\(--(green|amber|rouge)-soft\)/g) ?? []).toEqual([])
})
```

- [ ] **Step 2: 跑,确认失败**(workbench.css 约 100 处字面量)。

- [ ] **Step 3: 换**:每个字面色值按语义换 token —— 文字深 → `--th-ink`、文字浅 → `--th-ink-soft`、线 → `--th-hair`、面 → `--th-paper` / 侧栏面 → `--th-rail`、动作 → `--th-accent`(字 `--th-on-accent`)、成功 / 落后 / 失败的点 → `--th-ok/warn/bad`、错误文字 → `--th-bad`、阴影 → 删。`box-shadow` 一律删(只留焦点环 `outline`)。diff 视图里的增删行底色(+/−)属于代码呈现,用 `color-mix(in srgb, var(--th-ok) 12%, var(--th-paper))` / `color-mix(in srgb, var(--th-bad) 12%, var(--th-paper))`,不算字面量。状态签改「点 + 文字」。converse 气泡:CC 的话无底、我的话 `--th-rail` 底,圆角 `--th-radius-bubble`;工具条按钮次级样式(描边 `--th-hair`),「交给 CC 做」也是次级,只有发送是 accent。

- [ ] **Step 4: 跑** `bun --bun vitest run apps/desktop/src` → PASS;`cd apps/desktop && bun x playwright test` → 全绿;再跑一遍工作台相关浏览器冒烟:`bun scripts/workbench-attachments-browser-smoke.ts`(若需要 daemon 就跳过并在 PR 里注明)。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "桌面一起做与跟 CC 说换皮:零字面色值、状态只上点、去掉阴影与色块

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 桌面其余面板 token / 字体一遍 + 棘轮收紧

**Files:**
- Modify: `apps/desktop/src/styles.css`(回忆、记忆、待办、觅食、后厨、日志、插件、设置抽屉、引导向导各段)、`cc-surfaces.css`、`cc-page-art.css`、`postcard-album.css`
- Modify: `apps/desktop/src/design-style.test.ts`(`HEX_BUDGET` 下调到新实测)

**Interfaces:**
- Consumes: 同 Task 12 的语义映射表。
- Produces: `HEX_BUDGET` 每项 ≤ Task 8 的基线;`styles.css` 目标 ≤ 60(剩下的是插画 / 明信片等内容性颜色,注释说明)。

- [ ] **Step 1: 改守卫**:把 `HEX_BUDGET['styles.css']` 改成 `60`、`cc-surfaces.css` / `cc-page-art.css` / `postcard-album.css` 改成 `0`(若明信片画面需要内容色,改成实测值并在测试旁注释「明信片画面本身的颜色」)。
- [ ] **Step 2: 跑,确认失败。**
- [ ] **Step 3: 换**:同 Task 12 的映射;另外把非代码处的 `font-family: var(--mono)`(时间、计数、标签)改成继承衬线 —— 判据:选择器名含 `code|diff|log|path|cmd|pre|kbd|mono|id` 的保留 mono,其他删掉这行(`grep -n "font-family: var(--mono)" apps/desktop/src/styles.css` 逐条看)。结构、id、类名不动。
- [ ] **Step 4: 跑** `bun --bun vitest run apps/desktop/src && bun run test && npm run test:node && bun run typecheck` → 0;`cd apps/desktop && bun x playwright test` → 全绿。
- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "桌面其余面板过一遍 token 与衬线;时间与标签不再用等宽;字面色值棘轮收紧

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 桌面设计截图 + 两端对稿验收 + 文档

**Files:**
- Create: `apps/desktop/playwright/design-shots.spec.ts`
- Modify: `docs/INDEX.md`(加本 spec / plan 两行)、`docs/roadmap.md`(设计统一一行状态)
- Create(仓库外):`~/Documents/tendhearth/cc-screens-2026-10-01-design/README.md`

**Interfaces:**
- Consumes: `fixtures.ts` 的 `test`、`clickNav`;shim `demo.seed { presenceDown }`(Task 10)。
- Produces: 环境变量 `WECHAT_CC_DESIGN_SHOTS=<目录>` 才运行的出图用例。

- [ ] **Step 1: 写出图用例** `apps/desktop/playwright/design-shots.spec.ts`

```ts
// 设计验收出图(spec 2026-10-01 §7)。只有设了 WECHAT_CC_DESIGN_SHOTS 才跑,CI 跳过。
import { join } from 'node:path'
import { test, expect, clickNav } from './fixtures'

const OUT = process.env.WECHAT_CC_DESIGN_SHOTS
test.skip(!OUT, 'set WECHAT_CC_DESIGN_SHOTS=<dir> to capture design screenshots')

async function boot(page: any, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => document.documentElement.dataset.mode && document.documentElement.dataset.mode !== 'loading', { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function mockNow(page: any) {
  await page.route('**/v1/matter/owner-chat', (r: any) => r.fulfill({ json: { events: [
    { kind: 'user', text: '帮我看看下周出差', createdAt: Date.now() - 3_600_000 },
    { kind: 'text', text: '行程的几个备选方案整理好了，你看看？', createdAt: Date.now() - 1_800_000 } ] } }))
  await page.route('**/v1/workbench/attention**', (r: any) => r.fulfill({ json: { tasks: [
    { id: 't1', title: '让作品集在手机上更好看', providerId: 'claude', pendingPermissionCount: 1, pendingQuestionCount: 0, attentionKey: '["p1"]' },
    { id: 't2', title: '整理下周出差安排', providerId: 'claude', pendingPermissionCount: 0, pendingQuestionCount: 1, attentionKey: '["q1"]' } ] } }))
}

for (const [label, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 760, height: 1100 }]] as const) {
  test(`design shots · ${label}`, async ({ page, shimUrl, shim }) => {
    await page.setViewportSize(size)
    await shim.invoke('demo.seed', { chat_id: 'test_chat', daemonAlive: true })
    await mockNow(page)
    await boot(page, shimUrl)
    await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'here', { timeout: 25_000 })
    await expect(page.locator('#now-cc-bubble')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(OUT!, `d01-now-here-${label}.png`) })
    await page.locator('#now-cc').click()
    await page.screenshot({ path: join(OUT!, `d02-now-chat-${label}.png`) })
    for (const [i, pane] of (['workbench', 'recollections', 'memory', 'todos', 'a2a-agents', 'sessions'] as const).entries()) {
      await clickNav(page, pane)
      await page.screenshot({ path: join(OUT!, `d${String(i + 3).padStart(2, '0')}-${pane}-${label}.png`) })
    }
    await page.locator('#settings-open').click()
    await page.screenshot({ path: join(OUT!, `d09-settings-${label}.png`) })
  })
}
test('design shots · away', async ({ page, shimUrl, shim }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await shim.invoke('demo.seed', { chat_id: 'test_chat', presenceDown: true })
  await mockNow(page)
  await boot(page, shimUrl)
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-cc', 'away', { timeout: 25_000 })
  await page.screenshot({ path: join(OUT!, 'd10-now-away-wide.png') })
})
```

(`/v1/workbench/attention` 的真实路径以 `workbench-attention.js` 里调用的为准,`page.route` 的 glob 跟着改。)

- [ ] **Step 2: 出图**

```bash
OUT=~/Documents/tendhearth/cc-screens-2026-10-01-design/desktop && mkdir -p "$OUT"
cd apps/desktop && WECHAT_CC_DESIGN_SHOTS="$OUT" bun x playwright test design-shots
```

Expected: 3 个用例 PASS,`$OUT` 里 21 张图。再跑一遍完整 e2e(不设变量)`bun x playwright test` → 全绿(design-shots 被 skip)。

- [ ] **Step 3: 对稿**:用浏览器打开 `~/Documents/tendhearth/cc-screens-2026-09-30/desktop-redesign-now.html`(宽 1440 与 760 各截一张放进 `cc-screens-2026-10-01-design/mockup/`),逐张对比 `d01-now-here-wide.png` / `d01-now-here-narrow.png` / `d10-now-away-wide.png` 与手机 `p02-now.png`。在 `~/Documents/tendhearth/cc-screens-2026-10-01-design/README.md` 写:每张图是什么、跟稿的差异(逐条,例如「状态行文字是『CC 在家 · 运行中』,稿是『家里的电脑 · 在线』:桌面就是那台电脑」)、spec §9 待主人定的六条。

- [ ] **Step 4: 文档**:`docs/INDEX.md` 在 superpowers specs / plans 区加两行(本 spec、本 plan,标「plan 6」);`docs/roadmap.md` 在手机 app / 桌面一节加一行「设计统一(plan 6):两端同一套 token、衬线、无深色、CC 明暗来自真实信号 —— 截图在 cc-screens-2026-10-01-design」。`docs/全景导图.md` 若有「设计 / 风格」节点,把「Clean Light / Geist」那条标为被否决并指向本 spec(HTML 是生成物,不手改)。

- [ ] **Step 5: 全回路**:`bun run test && npm run test:node && bun run typecheck && bun run depcheck`;`cd apps/app && bun run test && bun run typecheck && bun run export:check`;`cd apps/desktop && bun x playwright test`。全部退出码 0。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/playwright/design-shots.spec.ts docs/INDEX.md docs/roadmap.md docs/全景导图.md
git commit -m "设计统一验收:桌面出图用例(env 开关)、对稿记录、文档索引

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 执行顺序与依赖

1 → 2 →(手机)3 → 4 → 5 → 6 → 7 →(桌面)8 → 9 → 10 → 11 → 12 → 13 → 14。
手机与桌面两条线在 Task 2 之后互不依赖,可以先手机后桌面,也可以 8–9 与 3–4 交错;但 Task 10 依赖 Task 8 的别名与字体、Task 11 依赖 Task 10 的气泡入口(e2e 改动顺序)。每个任务结束时两端都能构建、所有测试都绿。
