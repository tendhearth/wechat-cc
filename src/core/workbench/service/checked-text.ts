/**
 * 主人那句要求的最低门槛:必须是字符串、不超 20000 字、空文本只在带材料时放行;返回 trim 过的。
 * 从 service.ts 挪出(域模块要用,不能 import ../service)。
 */
import type { Attachment } from '../attachments'

export function checkedText(text: string,attachments:readonly Attachment[]=[]): string {
  if (typeof text !== 'string' || (!text.trim()&&!attachments.length) || text.length > 20_000) throw new Error('invalid_text')
  return text.trim()
}
