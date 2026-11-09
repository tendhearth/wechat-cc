import { expect, it, vi } from 'vitest'
import { readPermissionScript, presentPermissionScript } from './permission-script.js'
import { Window } from 'happy-dom'
it('reads bounded chunks for exactly the selected task, request, path and fingerprint',async()=>{
  const invoke=vi.fn(async(_method:string,path:string)=>path.endsWith('offset=0')?{content:'first\n',nextOffset:8000}:{content:'last',nextOffset:null})
  expect(await readPermissionScript(invoke,{id:'deadbeef',requestId:'req',path:'folder/check.py',sha256:'a'.repeat(64)})).toBe('first\nlast')
  expect(invoke.mock.calls.map(c=>c[0])).toEqual(['GET','GET'])
  expect(invoke.mock.calls[0]![1]).toContain('path=folder%2Fcheck.py')
  expect(invoke.mock.calls[1]![1]).toContain('offset=8000')
  await expect(readPermissionScript(async()=>({content:'x',nextOffset:0}),{id:'deadbeef',requestId:'req',path:'check.py',sha256:'a'.repeat(64)})).rejects.toThrow('permission_stale')
})
it('shows the completed script in the current card after progress replaces its DOM',async()=>{
  const window=new Window(),root=window.document.createElement('div'),query={id:'task',requestId:'req',path:'check.py',sha256:'hash'}
  const card='<div class="wb-permission-script"><pre>preview</pre><button data-action="expand-permission-script" data-owner-task="task" data-request-id="req" data-script-path="check.py" data-script-sha="hash">展开</button></div>'
  root.innerHTML=card
  let complete!:(part:{content:string;nextOffset:null})=>void
  const pending=readPermissionScript(async()=>await new Promise(resolve=>{complete=resolve}),query)
  const old=root.querySelector('button');root.innerHTML=card
  expect(root.querySelector('button')).not.toBe(old)
  complete({content:'full script after redraw',nextOffset:null})
  presentPermissionScript(root as unknown as HTMLElement,query,await pending)
  expect(root.querySelector('pre')?.textContent).toBe('full script after redraw')
  expect(root.querySelector('button')).toBeNull()
  root.innerHTML=card
  presentPermissionScript(root as unknown as HTMLElement,{...query,requestId:'other'},'wrong request')
  expect(root.querySelector('pre')?.textContent).toBe('preview')
  await window.happyDOM.abort()
})
