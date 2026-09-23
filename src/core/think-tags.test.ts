import { describe, it, expect } from 'vitest'
import { makeThinkFilter } from './think-tags'

/** 把一串 chunk 喂进去,收集可见文本(push 的产物 + end 的收尾)。 */
function run(chunks: string[]): string {
  const filter = makeThinkFilter()
  return chunks.map(c => filter.push(c)).join('') + filter.end()
}

describe('makeThinkFilter', () => {
  it('lets ordinary text through unchanged', () => {
    expect(run(['hello ', 'world'])).toBe('hello world')
  })

  it('does not hold back text that cannot start a think tag', () => {
    const filter = makeThinkFilter()
    // 流式要能立刻出字 —— 第一片就不像 `<think>` 时不许攒着。
    expect(filter.push('已完成')).toBe('已完成')
  })

  it('strips a complete leading think block', () => {
    expect(run(['<think>\nWe need to answer.\n</think>\nready'])).toBe('ready')
  })

  it('strips a think block whose tags are split across chunks', () => {
    expect(run(['<th', 'ink>\nWe', ' need answer.\n</thi', 'nk>\nrea', 'dy'])).toBe('ready')
  })

  it('strips a leading think block that follows whitespace', () => {
    expect(run(['\n  <think>hmm</think>answer'])).toBe('answer')
  })

  it('keeps a think tag that is not at the start of the message', () => {
    // 判定成普通文本之后就不再找标签 —— 聊 HTML 标签、贴代码不该被吃掉。
    expect(run(['写法是 <think>foo</think> 这样'])).toBe('写法是 <think>foo</think> 这样')
  })

  it('releases the buffer unchanged when the think block never closes', () => {
    // 多半是 token 预算烧光,这一轮已经按 finishReason 判失败了;
    // 丢掉半截思维链等于销毁证据,原样放行。
    expect(run(['<think>\nthinking forever'])).toBe('<think>\nthinking forever')
  })

  it('releases a partial tag that turns out not to be a think tag', () => {
    expect(run(['<th'])).toBe('<th')
  })

  it('drops the blank line between the close tag and the answer', () => {
    expect(run(['<think>hmm</think>\n\nready'])).toBe('ready')
  })

  it('drops the separator when it arrives in a chunk after the close tag', () => {
    // 真机 DeepSeek 就是这样:`</think>` 收在一片里,`\n\n` 在下一片 ——
    // 结果主人的任务里多出一条只有空白的可见事件。
    expect(run(['<think>hmm</think>', '\n\n', 'ready'])).toBe('ready')
  })

  it('keeps blank lines that belong to the answer itself', () => {
    expect(run(['<think>hmm</think>', '\n\n', 'para one', '\n\n', 'para two'])).toBe('para one\n\npara two')
  })

  it('streams the answer that arrives after the close tag in later chunks', () => {
    const filter = makeThinkFilter()
    expect(filter.push('<think>hmm</think>')).toBe('')
    expect(filter.push('rea')).toBe('rea')
    expect(filter.push('dy')).toBe('dy')
    expect(filter.end()).toBe('')
  })

  it('keeps an empty stream empty', () => {
    expect(run([])).toBe('')
  })
})
