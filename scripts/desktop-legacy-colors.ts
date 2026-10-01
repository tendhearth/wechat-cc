// 一次性:旧色板字面量 → 变量(spec 2026-10-01 §6.1)。只换与旧 :root 完全相同的值,剩下的由
// apps/desktop/src/design-style.test.ts 的 HEX_BUDGET 棘轮。2026-10-01 跑过一次,入库留作记录。
// 浮窗桌宠 / 动画实验室(companion-window.css / animation-lab.css)不在范围(spec §8),跳过。
import { readFileSync, writeFileSync, globSync } from 'node:fs'
const MAP: Record<string, string> = {
  '#fef9ef': 'var(--th-paper)', '#d8d4c8': 'var(--th-ground)', '#fbfaf7': 'var(--th-paper)', '#f4f2ec': 'var(--th-rail)',
  '#ecebe4': 'var(--th-rail)', '#f6f9f4': 'var(--th-paper)', '#593f2c': 'var(--th-ink)', '#82807a': 'var(--th-ink-soft)',
  '#b3b1a8': 'var(--th-ink-soft)', '#e8e6df': 'var(--th-hair)', '#d8d5cb': 'var(--th-hair)', '#2f7a4d': 'var(--th-accent)',
  '#246239': 'var(--th-accent)', '#e6efe5': 'transparent', '#1b5635': 'var(--th-accent)', '#a4751c': 'var(--th-warn)',
  '#f6ecd3': 'transparent', '#b04832': 'var(--th-bad)', '#f4dcd3': 'transparent', '#ffffff': 'var(--th-paper)', '#fff': 'var(--th-paper)',
}
for (const f of globSync('apps/desktop/src/**/*.css')) {
  if (f.endsWith('tokens.css') || f.includes('/vendor/')) continue
  if (/companion-window|animation-lab/.test(f)) continue
  const src = readFileSync(f, 'utf8')
  const out = src.replace(/#[0-9a-fA-F]{6}\b|#[fF]{3}\b/g, m => MAP[m.toLowerCase()] ?? m)
  if (out !== src) { writeFileSync(f, out); console.log('rewrote', f) }
}
