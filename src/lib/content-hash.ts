/**
 * 内容指纹:sha256 的十六进制。给「批的是哪一版」用(设计稿 2026-10-23-cc-runs-development §6 第 7 步:
 * 主人批过的那一版内容改了就得重批)。放在 lib:domain / app 不碰 node(depcheck `domain-no-node` / `app-no-node`)。
 */
import { createHash } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 「一件事」说一句的回执只存正文的指纹(adapters/store/say-receipts.ts;架构终态 E5 从那里搬来,app 的服务要算它)。 */
export const sayTextHash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
