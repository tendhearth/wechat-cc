import {describe,it,expect,vi} from 'vitest'

const evidence = await import('./memory-evidence.js').catch(()=>({})) as any
const memory={kind:'memory',path:'notes/a.md',label:'一条记忆'}
const observation={kind:'observation',id:'obs-1',label:'一次观察'}
const read=(content='原文',extra={})=>({ok:true,content,revision:'rev-1',editable:true,canMarkOutdated:false,needsRefresh:false,...extra})
function deferred(){let resolve!:(v:any)=>void,reject!:(e:Error)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function controller(call:any=vi.fn().mockResolvedValue(read()),onReviewed=vi.fn()){
  expect(evidence.createMemoryEvidenceController).toBeTypeOf('function')
  return {c:evidence.createMemoryEvidenceController({call,onReviewed}),call,onReviewed}
}

describe('verifiable profile evidence',()=>{
  it('never turns legacy source names into API paths',async()=>{
    const {c,call}=controller();await c.open({chatId:'owner',title:'旧画像',sources:['sleep.md','观察 1']})
    expect(c.state.refs).toEqual([]);expect(c.state.notice).toContain('旧画像未保存可核对依据，请更新画像');expect(call).not.toHaveBeenCalled()
  })
  it.each([memory,observation,{kind:'milestone',id:'milestone-2',label:'节点'},{kind:'project',project:'-alpha',path:'MEMORY.md',label:'项目'}])('reads only the typed %j identity under the profile chat',async ref=>{
    const {c,call}=controller();await c.open({chatId:'owner@wechat',title:'卡片',sourceRefs:[ref]})
    const query=new URL(call.mock.calls[0][1],'http://local').searchParams
    expect(query.get('chat_id')).toBe('owner@wechat');expect(query.get('kind')).toBe(ref.kind)
    for(const key of ['id','path','project'])expect(query.get(key)).toBe((ref as any)[key]??null)
    expect(c.state.draft).toBe('原文')
  })
  it('ignores a previous read after switching sources and after closing/reopening',async()=>{
    const old=deferred(),closed=deferred(),call=vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(read('第二条')).mockReturnValueOnce(closed.promise).mockResolvedValueOnce(read('新访问'))
    const {c}=controller(call);const opening=c.open({chatId:'owner',title:'卡片',sourceRefs:[memory,observation]});await c.select(1)
    old.resolve(read('迟到第一条'));await opening;expect(c.state.draft).toBe('第二条')
    const pending=c.select(0);c.requestClose();await c.open({chatId:'other',title:'另一人',sourceRefs:[memory]});closed.resolve(read('已关闭'));await pending
    expect(c.state.chatId).toBe('other');expect(c.state.draft).toBe('新访问')
  })
  it('retains the exact draft and revision after conflict, and serializes submission',async()=>{
    const saving=deferred(),call=vi.fn().mockResolvedValueOnce(read()).mockReturnValueOnce(saving.promise),{c}=controller(call)
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('我的改正');const first=c.review('correct');const second=c.review('correct');c.edit('提交中不能改')
    expect(c.state.saving).toBe(true);expect(c.state.draft).toBe('我的改正');expect(call.mock.calls.filter((r:any)=>r[0]==='POST')).toHaveLength(1)
    expect(call.mock.calls[1]).toEqual(['POST','/v1/memory/source/review',{chat_id:'owner',kind:'memory',path:'notes/a.md',revision:'rev-1',action:'correct',content:'我的改正'}])
    saving.resolve({ok:false,error:'source_changed'});await Promise.all([first,second])
    expect(c.state.draft).toBe('我的改正');expect(c.state.dirty).toBe(true);expect(c.state.error).toContain('来源已变化')
  })
  it('requires an explicit keep/discard choice on dirty close and source changes',async()=>{
    const {c}=controller();await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory,observation]});c.edit('保留的草稿');c.requestClose()
    expect(c.state.open).toBe(true);expect(c.state.confirmation).toBe('close');await c.resolveLeave('keep');expect(c.state.open).toBe(false)
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory,observation]});expect(c.state.draft).toBe('保留的草稿')
    await c.select(1);expect(c.state.selectedIndex).toBe(0);expect(c.state.confirmation).toBe('switch');await c.resolveLeave('stay');expect(c.state.dirty).toBe(true)
    await c.select(1);await c.resolveLeave('discard');expect(c.state.selectedIndex).toBe(1);await c.select(0);expect(c.state.draft).toBe('原文')
  })
  it('does not resurrect an explicitly discarded draft on the next open',async()=>{
    const {c}=controller();await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('明确放弃的草稿');c.requestClose();await c.resolveLeave('discard')
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});expect(c.state.draft).toBe('原文');expect(c.state.dirty).toBe(false)
  })
  it('removes a previously retained draft when the editor is restored to the original text',async()=>{
    const {c}=controller();await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('曾经保留的草稿');c.requestClose();await c.resolveLeave('keep')
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('原文');expect(c.state.dirty).toBe(false);c.requestClose()
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});expect(c.state.draft).toBe('原文');expect(c.state.dirty).toBe(false)
  })
  it('honors backend read-only and per-source review capabilities',async()=>{
    const call=vi.fn().mockResolvedValue(read('只读',{editable:false,canMarkOutdated:false})),{c}=controller(call)
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('不能改');await c.review('correct');await c.review('outdated')
    expect(c.state.draft).toBe('只读');expect(call).toHaveBeenCalledTimes(1)
  })
  it('keeps project and milestone evidence read-only even if response capabilities are inconsistent',async()=>{
    const {c,call}=controller();await c.open({chatId:'owner',title:'项目',sourceRefs:[{kind:'project',project:'-a',path:'note.md',label:'项目原文'}]})
    c.edit('不要写入项目');await c.review('correct');expect(c.state.source.editable).toBe(false);expect(c.state.draft).toBe('原文');expect(call).toHaveBeenCalledTimes(1)
  })
  it('keeps a retained draft attached to its original revision when re-reading changed evidence',async()=>{
    const {c,call}=controller(vi.fn().mockResolvedValueOnce(read()).mockResolvedValueOnce(read('别人改过',{revision:'rev-2'})).mockResolvedValue({ok:false,error:'source_changed'}))
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('我的草稿');c.requestClose();await c.resolveLeave('keep')
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});expect(c.state.draft).toBe('我的草稿');expect(c.state.revision).toBe('rev-1');expect(c.state.notice).toContain('来源已变化')
    await c.review('correct');expect(call).toHaveBeenCalledTimes(2);expect(c.state.draft).toBe('我的草稿')
  })
  it('allows explicit conflict recovery against newly read source text without losing or silently rebasing the draft',async()=>{
    const call=vi.fn().mockResolvedValueOnce(read()).mockResolvedValueOnce({ok:false,error:'source_changed'}).mockResolvedValueOnce(read('最新原文',{revision:'rev-2'})).mockResolvedValueOnce({ok:true,needsRefresh:true}),{c}=controller(call)
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('我的完整草稿');await c.review('correct');await c.refresh()
    expect(c.state.source.content).toBe('最新原文');expect(c.state.draft).toBe('我的完整草稿');expect(c.state.revision).toBe('rev-1')
    c.rebase();expect(c.state.revision).toBe('rev-2');expect(c.state.draft).toBe('我的完整草稿');expect(call).toHaveBeenCalledTimes(3)
    await c.review('correct');expect(call.mock.calls[3]![2]).toMatchObject({revision:'rev-2',content:'我的完整草稿'});expect(c.state.open).toBe(false)
  })
  it('marks only the reviewed profile stale and does not close a newer dialog visit',async()=>{
    const saving=deferred(),call=vi.fn().mockResolvedValueOnce(read()).mockReturnValueOnce(saving.promise).mockResolvedValueOnce(read('另一来源')),{c,onReviewed}=controller(call)
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[memory]});c.edit('改正');const pending=c.review('correct')
    await c.open({chatId:'other',title:'另一人',sourceRefs:[memory]});saving.resolve({ok:true,needsRefresh:true,revision:'rev-2'});await pending
    expect(onReviewed).toHaveBeenCalledWith({chatId:'owner',action:'correct'});expect(c.state.open).toBe(true);expect(c.state.chatId).toBe('other');expect(c.state.draft).toBe('另一来源')
  })
  it('marks an observation outdated without sending draft content and closes on success',async()=>{
    const {c,call,onReviewed}=controller(vi.fn().mockResolvedValueOnce(read('观察',{canMarkOutdated:true})).mockResolvedValueOnce({ok:true,needsRefresh:true}))
    await c.open({chatId:'owner',title:'卡片',sourceRefs:[observation]});await c.review('outdated')
    expect(call.mock.calls[1][2]).toEqual({chat_id:'owner',kind:'observation',id:'obs-1',revision:'rev-1',action:'outdated'})
    expect(c.state.open).toBe(false);expect(onReviewed).toHaveBeenCalledWith({chatId:'owner',action:'outdated'})
  })
})

function dialogFixture(call:any=vi.fn().mockResolvedValue(read())) {
  const listeners=new Map<string,(event:any)=>void>()
  const el=()=>({textContent:'',innerHTML:'',value:'',hidden:false,disabled:false,readOnly:false,focus:vi.fn(),addEventListener:vi.fn(),querySelector:()=>null})
  const title=el(),list=el(),editor=el(),notice=el(),error=el(),save=el(),outdated=el(),close=el(),confirm=el(),stay=el(),original=el(),originalDetails={...el(),open:false},editorLabel=el(),refresh=el(),rebase=el()
  confirm.querySelector=()=>stay as any
  const nodes={'h2':title,'.memory-evidence-sources':list,'textarea':editor,'.memory-evidence-notice':notice,'.memory-evidence-error':error,'[data-evidence-save]':save,'[data-evidence-outdated]':outdated,'[data-evidence-close]':close,'.memory-evidence-confirm':confirm,'#memory-evidence-original':original,'.memory-evidence-original':originalDetails,'label[for="memory-evidence-text"]':editorLabel,'[data-evidence-refresh]':refresh,'[data-evidence-rebase]':rebase}
  const opener={isConnected:true,dataset:{memoryEvidence:'trait:0'},focus:vi.fn()},replacement={focus:vi.fn()}
  const dialog={open:false,className:'',innerHTML:'',setAttribute:vi.fn(),querySelector:(s:string)=>(nodes as any)[s],addEventListener:(s:string,fn:any)=>listeners.set(s,fn),showModal(){this.open=true},close(){this.open=false}}
  const sourceButton={focus:vi.fn()}
  list.querySelector=()=>sourceButton as any
  const doc={body:{append:vi.fn()},activeElement:null as any,createElement:()=>dialog,querySelector:()=>replacement}
  const mounted=evidence.mountMemoryEvidenceDialog({call,documentTarget:doc})
  const click=(attr:string,value='')=>listeners.get('click')!({target:{closest:()=>({hasAttribute:(a:string)=>a===attr,dataset:attr==='data-evidence-leave'?{evidenceLeave:value}:attr==='data-evidence-source'?{evidenceSource:value}:{}})}})
  const input=(text:string)=>{editor.value=text;editor.addEventListener.mock.calls.find((x:any)=>x[0]==='input')![1]()}
  return {mounted,opener,replacement,dialog,editor,notice,error,save,outdated,close,confirm,stay,click,input,sourceButton,original,originalDetails,editorLabel,rebase,focusSource:(index:string)=>{doc.activeElement={getAttribute:()=>index}},cancel:()=>{const preventDefault=vi.fn();listeners.get('cancel')!({preventDefault});return preventDefault}}
}
describe('evidence dialog accessibility and text safety',()=>{
  it('renders raw source text without inserting markup and restores a replaced card trigger after close',async()=>{
    const f=dialogFixture(vi.fn().mockResolvedValue(read('<script>unsafe()</script>')))
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory]},f.opener)
    expect(f.editor.value).toBe('<script>unsafe()</script>');expect(f.dialog.innerHTML).not.toContain('unsafe()')
    f.opener.isConnected=false;f.click('data-evidence-close');expect(f.dialog.open).toBe(false);expect(f.replacement.focus).toHaveBeenCalledOnce()
  })
  it('Escape keeps dirty text, focuses the explicit choice, and Continue returns focus to editing',async()=>{
    const f=dialogFixture();await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory]},f.opener)
    f.input('未保存的改正');expect(f.cancel()).toHaveBeenCalledOnce();expect(f.dialog.open).toBe(true);expect(f.confirm.hidden).toBe(false);expect(f.stay.focus).toHaveBeenCalledOnce()
    f.click('data-evidence-leave','stay');expect(f.editor.value).toBe('未保存的改正');expect(f.editor.focus).toHaveBeenCalledOnce()
  })
  it('disables editor, save, outdated and close throughout a single submission',async()=>{
    const d=deferred(),call=vi.fn().mockResolvedValueOnce(read()).mockReturnValue(d.promise),f=dialogFixture(call)
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory]},f.opener);f.input('改正');f.click('data-evidence-save');f.click('data-evidence-save')
    expect(f.editor.disabled).toBe(true);expect(f.save.disabled).toBe(true);expect(f.outdated.disabled).toBe(true);expect(f.close.disabled).toBe(true);expect(call).toHaveBeenCalledTimes(2)
    d.resolve({ok:false,error:'source_changed'});await Promise.resolve();await Promise.resolve();expect(f.editor.value).toBe('改正');expect(f.editor.disabled).toBe(false)
  })
  it('keeps keyboard focus on the source chooser when its selected state updates',async()=>{
    const f=dialogFixture();await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory,observation]},f.opener)
    f.focusSource('1');f.click('data-evidence-source','1');expect(f.sourceButton.focus).toHaveBeenCalledOnce()
  })
  it('shows the actual archived text separately from an unsaved draft and forbids rebase or saving',async()=>{
    const call=vi.fn().mockResolvedValueOnce(read('原来的观察')).mockResolvedValueOnce(read('真实归档原文',{revision:'rev-2',editable:false,canMarkOutdated:false,archived:true})),f=dialogFixture(call)
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[observation]},f.opener);f.input('不能冒充原文的草稿');f.click('data-evidence-close');f.click('data-evidence-leave','keep')
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[observation]},f.opener)
    expect(f.original.textContent).toBe('真实归档原文');expect(f.originalDetails.open).toBe(true);expect(f.editorLabel.textContent).toContain('保留的草稿');expect(f.editor.value).toBe('不能冒充原文的草稿');expect(f.editor.readOnly).toBe(true)
    expect(f.notice.textContent).toContain('已过时');expect(f.save.hidden).toBe(true);expect(f.rebase.hidden).toBe(true)
    expect(f.dialog.innerHTML).not.toContain('当时参考')
  })
  it('disables saving a known stale draft until the user explicitly accepts the latest source as its baseline',async()=>{
    const call=vi.fn().mockResolvedValueOnce(read()).mockResolvedValueOnce(read('最新原文',{revision:'rev-2'})).mockResolvedValueOnce({ok:true,needsRefresh:true}),f=dialogFixture(call)
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory]},f.opener);f.input('保留的草稿');f.click('data-evidence-close');f.click('data-evidence-leave','keep')
    await f.mounted.open({chatId:'owner',title:'卡片',sourceRefs:[memory]},f.opener)
    expect(f.save.disabled).toBe(true);f.click('data-evidence-save');expect(call).toHaveBeenCalledTimes(2);expect(f.editor.value).toBe('保留的草稿')
    f.click('data-evidence-rebase');expect(f.save.disabled).toBe(false);f.click('data-evidence-save');expect(call.mock.calls[2]![2]).toMatchObject({revision:'rev-2',content:'保留的草稿'})
  })
})
