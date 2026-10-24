/**
 * 内容指纹:sha256 的十六进制。给「批的是哪一版」用(设计稿 2026-10-23-cc-runs-development §6 第 7 步:
 * 主人批过的那一版内容改了就得重批)。放在 lib:core 不碰 node(scripts/core-no-node.guard.test.ts)。
 */
import { createHash } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
