// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest'
import { openComputerSessions,terminalReferenceHtml,updateTerminalReferences } from './conversation-sessions.js'
it('preserves the existing read-only terminal projection in a stable conversation reference',()=>{
  document.body.innerHTML=terminalReferenceHtml('session','<backup>')
  const row=document.querySelector('details')!;row.open=true
  updateTerminalReferences([{session_id:'session',project:'<backup>',source:'codex',status:'running',last_summary:'核对中',last_event_at:1}])
  expect(row.textContent).toContain('在做');expect(row.textContent).toContain('核对中');expect(row.textContent).toContain('只读')
  expect(row.querySelector('backup')).toBeNull();expect(row.open).toBe(true)
  updateTerminalReferences([])
  expect(row.querySelector('[data-terminal-state]')!.textContent).toBe('尚未同步')
})
it('resource selection uses the current session identity; history remains an explicit separate action',()=>{
  const sessions=[{session_id:'s',project:'检查备份',status:'running'}],select=vi.fn(),history=vi.fn()
  openComputerSessions(()=>sessions,select,history)
  ;([...document.querySelectorAll('dialog button')].find(b=>b.textContent?.startsWith('检查备份')) as HTMLButtonElement).click()
  expect(select).toHaveBeenCalledWith(sessions[0]);expect(history).not.toHaveBeenCalled()
  openComputerSessions(()=>sessions,select,history)
  ;([...document.querySelectorAll('dialog button')].find(b=>b.textContent?.startsWith('查找')) as HTMLButtonElement).click()
  expect(history).toHaveBeenCalledOnce()
})

it('在电脑上的会话列表里用淡字提醒重开，只给已接上的行入口', () => {
  const connected = { session_id: 'connected', status: 'idle', project: '已接上的项目' }
  const unhooked = { session_id: 'unhooked', status: 'idle', project: '还没接上的项目', unhooked: true as const }
  const select = vi.fn()
  openComputerSessions(() => [unhooked, connected], select, vi.fn())
  const dialog = document.querySelector('dialog')!
  try {
    const note = dialog.querySelector('small.converse-terminal-note')
    expect(note?.textContent).toBe('开 hook 之前开的，重开这个会话才能接上')
    expect(note?.parentElement?.querySelector('button')).toBeNull()
    const connectedButton = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.startsWith(connected.project))
    connectedButton?.click()
    expect(select).toHaveBeenCalledExactlyOnceWith(connected)
  } finally { dialog.remove() }
})
