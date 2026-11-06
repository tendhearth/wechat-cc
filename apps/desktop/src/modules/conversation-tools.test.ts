// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mountConversationTools } from './conversation-tools.js'
it('keeps engineering and life functions reachable from the same conversation', () => {
  const root=document.createElement('div');root.innerHTML='<button id="converse-delegate">交给 CC 做</button>'; document.body.replaceChildren(root)
  const delegate=vi.fn(),search=vi.fn(),history=vi.fn(),projects=vi.fn(),navigate=vi.fn()
  mountConversationTools({root,delegate,search,history,projects,navigate})
  expect((root.querySelector('#converse-delegate') as HTMLElement).hidden).toBe(true)
  const click=(label:string)=>[...root.querySelectorAll('button')].find(b=>b.textContent===label)!.click()
  click('交办一件事');expect(delegate).toHaveBeenCalledOnce()
  click('搜索事项');expect(search).toHaveBeenCalledOnce()
  click('电脑上的会话');expect(history).toHaveBeenCalledOnce()
  click('项目与文件夹');expect(projects).toHaveBeenCalledOnce()
  for(const [label,name] of [['回忆','recollections'],['画室与相册','atelier'],['记忆与纠错','memory'],['待办','todos'],['觅食','a2a-agents'],['后厨','sessions']] as const){click(label);expect(navigate).toHaveBeenCalledWith(name)}
  expect([...root.querySelectorAll('button')].some(button=>button.textContent==='全部')).toBe(false)
})
