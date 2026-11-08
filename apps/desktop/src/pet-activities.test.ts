// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {mountPetActivities,normalizePetActivities} from './pet-activities.js'
const a={taskId:'deadbeef',title:'修好排版',phase:'needs_input',detail:'需要确认本地检查',updatedAt:1}
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks()})
function mount(){
 document.body.innerHTML='<div id="host" hidden><button id="primary" type="button"></button><button id="toggle" type="button" aria-expanded="false"></button><div id="list" hidden></div></div>'
 const opens:unknown[]=[]
 const view=mountPetActivities({host:document.getElementById('host')!,primary:document.getElementById('primary')!,toggle:document.getElementById('toggle')!,list:document.getElementById('list')!,onOpen:(target:unknown)=>opens.push(target)})
 return {view,opens,host:document.getElementById('host')!,primary:document.getElementById('primary')!,toggle:document.getElementById('toggle')!,list:document.getElementById('list')!}
}
it('validates task identity, finite facts and phases, deduplicates and bounds visible data',()=>{
 const rows=normalizePetActivities([a,{...a,title:'重复'},{...a,taskId:'../deadbeef'},{...a,taskId:'aaaa1111',phase:'unread'},{...a,taskId:'bbbb2222',updatedAt:NaN},{...a,taskId:'cccc3333',title:'  <img src=x onerror=alert(1)>\n'+'字'.repeat(100)}])
 expect(rows).toHaveLength(2);expect(rows[0]).toEqual(a);expect(rows[1]!.title.length).toBeLessThanOrEqual(80);expect(rows[1]!.title).not.toMatch(/\n/)
 expect(normalizePetActivities(null)).toEqual([])
 expect(normalizePetActivities(Array.from({length:20},(_,n)=>({...a,taskId:n.toString(16).padStart(8,'0')})))).toHaveLength(8)
})
it('opens the exact primary or selected list task and renders untrusted titles only as text',()=>{
 const {view,opens,host,primary,toggle,list}=mount()
 view.update([a,{...a,taskId:'bbbb2222',title:'<img src=x onerror=alert(1)>',phase:'working',detail:null}],true)
 expect(host.hidden).toBe(false);expect(primary.textContent).toContain('修好排版');expect(primary.textContent).toContain('等你决定')
 primary.click();expect(opens).toEqual([{page:'workbench',taskId:'deadbeef'}])
 toggle.click();expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(list.hidden).toBe(false);expect(list.querySelector('img')).toBeNull()
 list.querySelector<HTMLButtonElement>('[data-task-id="bbbb2222"]')!.click()
 expect(opens).toEqual([{page:'workbench',taskId:'deadbeef'},{page:'workbench',taskId:'bbbb2222'}]);expect(list.hidden).toBe(true)
})
it('hides stale targets for disconnection or permission priority and clears the current target',()=>{
 const {view,host,primary,toggle,list,opens}=mount();view.update([a,{...a,taskId:'bbbb2222'}],true);toggle.click()
 view.update([a],false);expect(host.hidden).toBe(true);expect(list.hidden).toBe(true);expect(view.current()).toBeNull()
 primary.click();expect(opens).toEqual([])
 view.update([a],true);expect(view.current()).toEqual({page:'workbench',taskId:'deadbeef'})
 view.update([],true);expect(host.hidden).toBe(true);expect(view.current()).toBeNull()
})
it('retains keyboard focus across unchanged polls and Escape collapses the chooser without closing CC',()=>{
 const {view,toggle,list}=mount();view.update([a,{...a,taskId:'bbbb2222',phase:'working'}],true);toggle.click()
 const target=list.querySelector<HTMLButtonElement>('[data-task-id="bbbb2222"]')!;target.focus()
 view.update([{...a,updatedAt:10},{...a,taskId:'bbbb2222',phase:'working',updatedAt:11}],true)
 expect(document.activeElement).toBe(target)
 const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});target.dispatchEvent(escape)
 expect(escape.defaultPrevented).toBe(true);expect(list.hidden).toBe(true);expect(document.activeElement).toBe(toggle)
})

it('preserves the focused task across reordering and returns to a visible entry when that task disappears',()=>{
 vi.spyOn(document,'hasFocus').mockReturnValue(true)
 const {view,toggle,list,primary,opens}=mount(),b={...a,taskId:'bbbb2222',phase:'working'}
 view.update([a,b],true);toggle.click()
 const button=list.querySelector<HTMLButtonElement>('[data-task-id="bbbb2222"]')!;button.focus()
 view.update([b,a],true);expect(document.activeElement).toBe(button)
 button.click();expect(opens).toEqual([{page:'workbench',taskId:'bbbb2222'}])
 toggle.click();button.focus();view.update([a],true)
 expect(document.activeElement).toBe(primary);expect(list.hidden).toBe(true)
})
it('does not acquire focus from another application when updating the chooser',()=>{
 vi.spyOn(document,'hasFocus').mockReturnValue(false)
 const {view,toggle,list}=mount(),b={...a,taskId:'bbbb2222'};view.update([a,b],true);toggle.click()
 const button=list.querySelector<HTMLButtonElement>('[data-task-id="bbbb2222"]')!;button.focus()
 const focus=vi.spyOn(button,'focus');view.update([b,a],true);expect(focus).not.toHaveBeenCalled()
})
