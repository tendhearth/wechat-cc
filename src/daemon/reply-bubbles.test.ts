import { describe, it, expect } from 'vitest'
import { splitBubbles, splitOversizedFence, MAX_BUBBLES } from './reply-bubbles'

describe('splitBubbles — 模型空行分段,daemon 照段分条(已定 ④)', () => {
  it('一段 ⇒ 一条(再短也不切,没有 100 字门槛的反面:短也照样按空行分)', () => {
    expect(splitBubbles('好的,收到!')).toEqual(['好的,收到!'])
  })

  it('空行分隔的段就是气泡 —— 去掉了「总长 < 100 不切」的门槛', () => {
    expect(splitBubbles('周末去爬山吧,空气好。\n\n或者去看一场电影放松下。\n\n再不然在家睡个懒觉也很好。'))
      .toEqual(['周末去爬山吧,空气好。', '或者去看一场电影放松下。', '再不然在家睡个懒觉也很好。'])
  })

  it('多个空行 / 带空白的空行都算一个分隔', () => {
    expect(splitBubbles('第一条消息内容在这里\n \n\n第二条消息内容在这里')).toEqual(['第一条消息内容在这里', '第二条消息内容在这里'])
  })

  it('< 10 个可见字的碎段并入上一条', () => {
    expect(splitBubbles('这是一条足够长的正经消息。\n\n😄')).toEqual(['这是一条足够长的正经消息。\n\n😄'])
  })

  it('第一段就是碎段 ⇒ 并入下一条(没有上一条可并)', () => {
    expect(splitBubbles('嗯!\n\n这是一条足够长的正经消息。')).toEqual(['嗯!\n\n这是一条足够长的正经消息。'])
  })

  it('最多 4 条,多出来的从后往前合并', () => {
    const paras = ['第一个建议:出门走走晒太阳', '第二个建议:约朋友吃个饭吧', '第三个建议:看一部老电影吧', '第四个建议:早点睡觉补觉吧', '第五个建议:整理一下房间吧']
    const out = splitBubbles(paras.join('\n\n'))
    expect(MAX_BUBBLES).toBe(4)
    expect(out).toHaveLength(4)
    expect(out.slice(0, 3)).toEqual(paras.slice(0, 3))
    expect(out[3]).toBe(`${paras[3]}\n\n${paras[4]}`)
  })

  it('代码块永远整块:围栏里的空行不是分隔', () => {
    const code = '```ts\nconst a = 1\n\nconst b = 2\n```'
    expect(splitBubbles(`改成这样就行,注意中间那行:\n${code}\n\n改完重启一下 daemon。`))
      .toEqual([`改成这样就行,注意中间那行:\n${code}`, '改完重启一下 daemon。'])
  })

  it('未闭合的围栏吞到结尾,不切', () => {
    const t = '先说一句足够长的开场白。\n\n```py\nprint(1)\n\nprint(2)'
    expect(splitBubbles(t)).toEqual(['先说一句足够长的开场白。', '```py\nprint(1)\n\nprint(2)'])
  })

  it('单段超过约 300 字 ⇒ 按句末切', () => {
    const s = '这是一句不短不长的话,用来把段落撑长一些。'
    const long = s.repeat(20) // ~420 字,没有空行
    const out = splitBubbles(long)
    expect(out.length).toBeGreaterThan(1)
    expect(out.join('')).toBe(long)
    for (const b of out) expect(b.endsWith('。')).toBe(true)
  })

  it('以冒号结尾的引导段和后面那段是一个意思,不拆开(「你有两个项目:」+ 列表)', () => {
    expect(splitBubbles('你目前注册了两个项目：\n\n- wechat-cc(当前)\n- blog\n\n要切换的话跟我说一声就行。'))
      .toEqual(['你目前注册了两个项目：\n\n- wechat-cc(当前)\n- blog', '要切换的话跟我说一声就行。'])
  })

  it('同一个列表的各项之间有空行(带缩进子项)也不拆', () => {
    expect(splitBubbles('项目：\n\n1. **wechat-cc**\n   - 当前\n\n2. **blog**\n   - 停更\n\n建议先推进 wechat-cc,这周有交付窗口。'))
      .toEqual(['项目：\n\n1. **wechat-cc**\n   - 当前\n\n2. **blog**\n   - 停更', '建议先推进 wechat-cc,这周有交付窗口。'])
  })

  it('split=false ⇒ 一整条', () => {
    expect(splitBubbles('第一条消息内容在这里\n\n第二条消息内容在这里', { split: false })).toEqual(['第一条消息内容在这里\n\n第二条消息内容在这里'])
  })

  it('空文本 ⇒ 没有气泡', () => {
    expect(splitBubbles('   \n\n ')).toEqual([])
  })

  it('超过 4000 的代码块:先按行切,每段补齐围栏', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i} // padding padding`)
    const code = '```js\n' + lines.join('\n') + '\n```'
    const out = splitBubbles(code)
    expect(out.length).toBeGreaterThan(1)
    for (const b of out) {
      expect(b.length).toBeLessThanOrEqual(4000)
      expect(b.startsWith('```js\n')).toBe(true)
      expect(b.endsWith('\n```')).toBe(true)
    }
    const body = out.map(b => b.slice('```js\n'.length, -'\n```'.length)).join('\n')
    expect(body).toBe(lines.join('\n'))
  })
})

describe('splitOversizedFence', () => {
  it('不超限 ⇒ 原样', () => {
    expect(splitOversizedFence('```\nx\n```', 4000)).toEqual(['```\nx\n```'])
  })
})
