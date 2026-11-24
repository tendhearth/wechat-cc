import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const files = [
  'modules/workbench.js',
  'modules/places-strip.js',
  'modules/terminal-thread.js',
  'modules/now-page.js',
  'modules/conversation-work-detail.js',
  'pet/permission/permission-card.js',
]

const oldLabel = '(?:允许|拒绝|不允许)'
const quote = "['\"`]"
const quotedLabel = `${quote}${oldLabel}${quote}`
const decision = String.raw`['"](?:allow|deny)['"]`
const interpolatedLabel = String.raw`\$\{\s*(?:${quotedLabel}\s*\}|[^{}]*[?:]\s*${quotedLabel}\s*(?=[:}])[^{}]*\})`
const buttonLabels = [
  // HTML button text, including the workbench's interpolated label.
  String.raw`<button\b[^<>]*>\s*(?:${oldLabel}|${interpolatedLabel})\s*</button>`,
  String.raw`<button\b[^<>]*\s(?:aria-label|title)\s*=\s*${quotedLabel}(?=\s|>)`,
  // The two DOM builders pass labels as decision pairs or to make('button', className, label).
  String.raw`\[\s*(?:${decision}\s*,\s*${quotedLabel}|${quotedLabel}\s*,\s*${decision})\s*\]`,
  String.raw`\bmake\(\s*['"]button['"]\s*,\s*[^,]+,\s*${quotedLabel}\s*\)`,
  String.raw`\b(?:button|b|allow|deny)\.(?:textContent|ariaLabel|title)\s*=\s*${quotedLabel}(?=[ \t]*(?:[;\r\n}]|$))`,
]

it.each(files)('%s 使用统一的拍板按钮用词', file => {
  const source = readFileSync(join(__dirname, file), 'utf8')
    .split(/\r?\n/).filter(line => !/^\s*(?:\/\/|\/\*|\*|<!--)/.test(line)).join('\n')
  expect(source.match(new RegExp(buttonLabels.join('|'), 'gu')) ?? []).toEqual([])
})
