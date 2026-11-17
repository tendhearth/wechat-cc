import {expect,it} from 'vitest'
import {renderWorkbenchLedger} from './workbench-ledger.js'
it('单终端参与者也展示记录本、目录、接通状态和摘下按钮',()=>{
  const p={id:'p1',matterId:'12345678',sessionId:'abcdef-session',source:'claude',cwd:'/tmp/<project>',activity:'idle',detachedAt:null,connection:'pending' as const}
  const detail={task:{id:'12345678'},agentRuns:[],terminalParticipants:[p],notes:[{matterId:'12345678',author:'claude',text:'已完成第一段'}]} as unknown as Parameters<typeof renderWorkbenchLedger>[0]
  const render=()=>renderWorkbenchLedger(detail,id=>id==='claude'?'Claude':id)
  expect(render()).toContain('Claude · 终端 · abcdef')
  expect(render()).toContain('/tmp/&lt;project&gt;')
  expect(render()).toContain('已挂入，待接通')
  expect(render()).toContain('已完成第一段')
  expect(render()).toContain('data-participation-id="p1"')
  detail.terminalParticipants![0]!.connection='connected'
  expect(render()).toContain('记录本已接通')
  detail.terminalParticipants![0]!.detachedAt=1
  expect(render()).not.toContain('data-participation-id')
})
it('接通状态进入详情结构签名，长轮询收到后会重画',async()=>{
  const {structuralSignature}=await import('./workbench-live.js')
  const base={task:{id:'12345678'},terminalParticipants:[{id:'p',connection:'pending'}]} as unknown as Parameters<typeof structuralSignature>[0]
  const connected={...base,terminalParticipants:[{id:'p',connection:'connected'}]} as unknown as Parameters<typeof structuralSignature>[0]
  expect(structuralSignature(base)).not.toBe(structuralSignature(connected))
})
