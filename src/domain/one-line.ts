/**
 * 把一段话压成手机 / 微信上的一行(从 src/app/cli-events.ts 搬来,M4d:终端会话的「最近一句」改从这件事的步推,
 * 读的时候在 domain 里压,不再只在写 cli_sessions 时压)。纯函数,不碰 node。
 */

/** 压成一行、截到上限;空串原样。 */
export function summarizeOneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return one.slice(0, max - 1) + '…'
}

/**
 * 微信不认 markdown:去掉记号、留下结构。星号粗体、反引号、标题井号、列表点、链接。
 * 段落间最多留一个空行。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
