import { describe, it, expect } from 'vitest'
import { parseCatch, deriveTitle } from './hunt-catch'

describe('parseCatch —— 打猎回信 → 猎物', () => {
  it('典型两条:一段一条,链接和原文都留住', () => {
    const items = parseCatch(`今天打到两个：

Continue.dev 开源了 agent 模式，你上次说想要一个能自己改多文件的编辑器插件。https://github.com/continuedev/continue

另外这篇讲 SQLite WAL 在高并发下的实测，跟你队列那个卡顿直接相关。https://example.com/wal-bench`)
    expect(items).toHaveLength(2) // 开场白「今天打到两个：」不算猎物
    expect(items[0]!.url).toBe('https://github.com/continuedev/continue')
    expect(items[0]!.note).toContain('你上次说想要')
    expect(items[1]!.url).toBe('https://example.com/wal-bench')
  })

  it('一段里挤了多条 → 按行拆,不带链接的行并进上一条', () => {
    const items = parseCatch(`1. Zed 的 AI 面板 https://zed.dev/ai
说是本地模型也能用
2. Cursor 的 composer https://cursor.sh/composer`)
    expect(items.map(i => i.url)).toEqual(['https://zed.dev/ai', 'https://cursor.sh/composer'])
    // 说明文字属于上一条,而不是变成一条无链接的碎片
    expect(items[0]!.note).toContain('本地模型也能用')
  })

  it('**一条链接都没有也要记** —— 打猎不是每次都带链接回来', () => {
    const items = parseCatch('今天没找到链接，但你关注的那个团队昨天发了 1.0。')
    expect(items).toHaveLength(1)
    expect(items[0]!.url).toBeNull()
    expect(items[0]!.note).toContain('发了 1.0')
  })

  it('**开场白只砍第一段** —— 后面出现的无链接段落是真内容,不能丢', () => {
    const items = parseCatch(`今天两条：

Foo https://a.com

另外那个团队昨天发了 1.0，没找到链接。`)
    expect(items).toHaveLength(2)
    expect(items[1]!.note).toContain('发了 1.0')
  })

  it('整段都没有链接时,第一段就是内容本身,绝不能砍', () => {
    const items = parseCatch('今天没找到链接。\n\n但那个团队昨天发了 1.0。')
    expect(items).toHaveLength(2)
    expect(items[0]!.note).toContain('今天没找到链接')
  })

  it('空文本 → 空数组(而不是一条空猎物)', () => {
    expect(parseCatch('')).toEqual([])
    expect(parseCatch('   \n\n  ')).toEqual([])
  })

  it('链接末尾的中文标点不被吃进 URL', () => {
    const items = parseCatch('看这个 https://example.com/a，很有意思。')
    expect(items[0]!.url).toBe('https://example.com/a')
  })

  it('列表前缀属于排版,不进正文', () => {
    expect(parseCatch('- 就这一条 https://x.com/y')[0]!.note.startsWith('就这一条')).toBe(true)
    expect(parseCatch('① 就这一条 https://x.com/y')[0]!.note.startsWith('就这一条')).toBe(true)
  })
})

describe('deriveTitle —— 只是给列表扫读用的派生字段', () => {
  it('取第一个句读之前的部分', () => {
    expect(deriveTitle('Continue.dev 开源了 agent 模式。它能改多文件', null)).toBe('Continue.dev 开源了 agent 模式')
  })

  it('「——」和冒号也算断点(常用来分隔「是什么」和「为什么」)', () => {
    expect(deriveTitle('Zed AI 面板——本地模型也能跑', null)).toBe('Zed AI 面板')
    expect(deriveTitle('Zed AI 面板：本地模型也能跑', null)).toBe('Zed AI 面板')
  })

  it('过长截断带省略号', () => {
    const t = deriveTitle('这是一个特别特别特别特别特别特别特别特别特别特别特别特别长的标题而且没有句号', null)
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBe(33) // 32 + 省略号

    // 边界:正好 32 字不截断(截断一个刚好放得下的标题只会白丢信息)
    const exact = '一'.repeat(32)
    expect(deriveTitle(exact, null)).toBe(exact)
  })

  it('整段就是个链接 → 回落到域名', () => {
    expect(deriveTitle('https://github.com/foo/bar', 'https://github.com/foo/bar')).toBe('github.com')
  })

  it('既无文字也无链接 → 不返回空串(空标题在列表里是个看不见的行)', () => {
    expect(deriveTitle('', null)).toBe('(无标题)')
  })
})
