/**
 * think-tags.ts — 把内联在 `content` 里的思维链从可见回复里剥掉。
 *
 * 守规矩的端点把推理放在 `reasoning_content` 字段,`@ai-sdk/openai-compatible`
 * 会解析成 `reasoning-delta`,我们两条流都不消费它 —— 于是天然不泄漏。
 * 但有的网关把它**内联进 `content`**:2026-09-14 实测某网关的 DeepSeek,
 * 原始流是 `'<think>\nWe need answer only "ready".\n</think>\nready'`,
 * 整段思维链就这么当成助手文本发给了主人(工作台里主人看到的回复就是 `<think>`)。
 *
 * 只认**开头**的完整 `<think>…</think>`,判定成普通文本后就不再找标签:
 * 我们每一步 `streamTurn` 都是一条新流、配一条新 filter,工具调用之后那段
 * 推理是下一条流自己的开头,所以不会漏;而"只认开头"换来的是聊 HTML 标签、
 * 贴代码时不会被误吃。没闭合就原样放行 —— 那多半是 token 预算烧光,
 * 这一轮已经按 finishReason 判失败了,丢掉半截思维链等于销毁证据。
 */

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

export interface ThinkFilter {
  /** 喂一片原始文本,返回这一片该让主人看见的部分(可能是空串)。 */
  push(chunk: string): string
  /** 流结束:把还攒着的东西交出来。 */
  end(): string
}

/** gap:闭合标签之后、答案第一个字之前 —— 分隔用的空行可能落在后面几片里。 */
type Mode = 'detecting' | 'reasoning' | 'gap' | 'text'

export function makeThinkFilter(): ThinkFilter {
  let mode: Mode = 'detecting'
  let buffer = ''

  const afterClose = (text: string): string => text.replace(/^[\r\n\t ]+/, '')

  return {
    push(chunk) {
      if (mode === 'text') return chunk
      if (mode === 'gap') {
        const rest = afterClose(chunk)
        if (!rest) return ''
        mode = 'text'
        return rest
      }
      buffer += chunk
      if (mode === 'detecting') {
        const start = buffer.trimStart()
        if (start.startsWith(THINK_OPEN)) mode = 'reasoning'
        // 还可能长成 `<think>` 就先攒着,不然流式会把半个标签吐出去。
        else if (THINK_OPEN.startsWith(start)) return ''
        else { mode = 'text'; const out = buffer; buffer = ''; return out }
      }
      const close = buffer.indexOf(THINK_CLOSE)
      if (close === -1) return ''
      const answer = afterClose(buffer.slice(close + THINK_CLOSE.length))
      mode = answer ? 'text' : 'gap'
      buffer = ''
      return answer
    },
    end() {
      const out = buffer
      buffer = ''
      mode = 'text'
      return out
    },
  }
}
