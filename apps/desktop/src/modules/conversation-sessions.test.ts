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
