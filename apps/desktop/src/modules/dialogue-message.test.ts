import {expect, it} from 'vitest'
import {Window} from 'happy-dom'
import {renderDialogueMessage} from './dialogue-page.js'

const context = {userName:'我'}
const message = (text:string, direction:'in'|'out'='out', kind='text') => ({id:'history-1',chatId:'owner',ts:'2026-10-02T12:00:00Z',direction,kind,text,source:'desktop'})
const rendered = (text:string, direction:'in'|'out'='out', kind='text') => {
  const window = new Window()
  window.document.body.innerHTML = renderDialogueMessage(message(text,direction,kind),context)
  return window.document.body
}

it('renders assistant history as structured Markdown without modifying the source message', () => {
  const text = '## 结果\n\n**完成**\n\n- 第一项\n- 第二项\n\n```ts\n  const count = 1\n```\n\n| 事项 | 结果 |\n| --- | --- |\n| 阅读 | 已完成 |'
  const original = message(text)
  const html = renderDialogueMessage(original,context)
  const window = new Window()
  window.document.body.innerHTML = html
  const body = window.document.body.querySelector('.dialogue-message-text')!
  expect(body.querySelector('h2')?.textContent).toBe('结果')
  expect(body.querySelector('strong')?.textContent).toBe('完成')
  expect(body.querySelectorAll('li')).toHaveLength(2)
  expect(body.querySelector('pre code')?.textContent).toBe('  const count = 1\n')
  expect(body.querySelector('table')).not.toBeNull()
  expect(original.text).toBe(text)
})

it('renders user Markdown with exact source inspection and leaves commands and media literal', () => {
  const text = '\n\n**保留字面符号**\r\n\r\n    带缩进 <script>'
  const user = rendered(text,'in').querySelector('.dialogue-message-text')!
  expect(user.querySelector('.cc-readable-markdown strong')?.textContent).toBe('保留字面符号')
  const source=user.querySelector('details')!;source.open=true
  expect(source.querySelector('pre code')?.textContent).toBe(text)
  expect(user.querySelector('script')).toBeNull()
  const commandText='**命令原文**\n\n    带缩进 <script>'
  const command = rendered(commandText,'out','command')
  expect(command.querySelector('.dialogue-cmd')?.textContent).toBe(commandText)
  expect(command.querySelector('strong')).toBeNull()
  expect(rendered(commandText,'out','file').querySelector('.dialogue-message-plain')?.textContent).toBe(commandText)
  const plain='普通消息\n\n空行\n  两个空格'
  const plainBody=rendered(plain,'in')
  expect(plainBody.querySelector('.cc-user-plain')?.textContent).toBe(plain)
  expect(plainBody.querySelector('details')).toBeNull()
})

it('escapes assistant HTML and renders only safe web links without loading remote images', () => {
  const body = rendered('<script>alert(1)</script>\n\n[safe](https://example.test/read)\n\n[bad](javascript:alert(1))\n\n![外部图片](https://example.test/image.png)\n\n[本地文档](/Users/private/doc.md)')
  expect(body.querySelector('script')).toBeNull()
  expect(body.querySelectorAll('a')).toHaveLength(1)
  expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.test/read')
  expect(body.querySelector('.dialogue-message-text img')).toBeNull()
  expect(body.textContent).toContain('本地文档')
  expect(body.textContent).not.toContain('/Users/private/doc.md')
})
