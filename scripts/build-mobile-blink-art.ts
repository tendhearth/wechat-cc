import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// 「CC 眼中的你」的眨眼帧:256px 全彩,懒加载(不进 /m 页面,守 512KB 中继帧)。源文件在 apps/mobile/art/。
const art = Object.fromEntries((['half', 'closed'] as const).map(key => {
  const path = `apps/mobile/art/blink-${key}-256.png`
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url))
  return [key, { source: path, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }]
}))
writeFileSync(new URL('../src/daemon/mobile-blink-art.json', import.meta.url), JSON.stringify(art) + '\n')
