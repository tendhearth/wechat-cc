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
// 只打包 Noto Serif SC Regular(无 CJK Medium):凡可能出现中文的角色一律 regular,层级靠字号与留白。
// 仅 wordmark("Tendhearth",纯拉丁)用 TH Serif 4 Medium(Source Serif 4 子集,因 OFL 保留字体名 'Source' 改名)。
export const typeScale: Record<TypeRole, { desktop: number; phone: number; lineHeight: number; weight: 'regular' | 'medium'; tracking: number }> = {
  display:  { desktop: 48, phone: 36, lineHeight: 1.15, weight: 'regular', tracking: 0 },
  wordmark: { desktop: 24, phone: 20, lineHeight: 1.2,  weight: 'medium',  tracking: 0.01 },
  title:    { desktop: 22, phone: 20, lineHeight: 1.3,  weight: 'regular', tracking: 0 },
  item:     { desktop: 18, phone: 17, lineHeight: 1.4,  weight: 'regular', tracking: 0 },
  body:     { desktop: 16, phone: 16, lineHeight: 1.6,  weight: 'regular', tracking: 0 },
  bubble:   { desktop: 15, phone: 15, lineHeight: 1.6,  weight: 'regular', tracking: 0 },
  meta:     { desktop: 14, phone: 14, lineHeight: 1.5,  weight: 'regular', tracking: 0.04 },
  small:    { desktop: 13, phone: 13, lineHeight: 1.5,  weight: 'regular', tracking: 0 },
  caption:  { desktop: 12, phone: 12, lineHeight: 1.4,  weight: 'regular', tracking: 0 },
}
export const fontFamily = { serifLatin: 'TH Serif 4', serifCJK: 'Noto Serif SC', mono: 'Geist Mono' } as const
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
    // 桌面英文优先引用本机 Anthropic Sans;缺失时回退系统,中文保留本地 CJK 回退。
    '  --th-font-sans: "CC Anthropic Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Helvetica Neue", Arial, sans-serif;',
    // 阅读正文的英文衬线与中文无衬线分工;本机缺少 Claude Serif 时用已打包的拉丁衬线。
    `  --th-font-reading: "CC Anthropic Serif", "${fontFamily.serifLatin}", var(--th-font-sans);`,
    // 打包的 Noto Serif SC 只有常用字(spec §9-5);子集外的字由浏览器逐字落到后面的系统衬线:macOS 宋体、Linux / 装了 Noto 的 Windows 思源宋体、Windows 宋体。
    `  --th-font-serif: "${fontFamily.serifLatin}", "${fontFamily.serifCJK}", "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif;`,
    `  --th-font-mono: "${fontFamily.mono}", ui-monospace, "SF Mono", Menlo, monospace;`,
    '  color-scheme: light;',
  )
  return `/* 生成物:bun scripts/build-design-tokens.ts(出处 packages/design-tokens/src/index.ts)。别手改。 */\n:root {\n${lines.join('\n')}\n}\n`
}
