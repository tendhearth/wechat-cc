import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {openTestDb,type Db} from '../../lib/db'
import {makeWorkbenchStore,type WorkbenchStore} from './store'
import {makeWechatWorkbenchControl} from './wechat-control'
import {resultToken,wechatResultPage} from './wechat-results'

let db:Db,store:WorkbenchStore
beforeEach(()=>{db=openTestDb();store=makeWorkbenchStore(db)})
afterEach(()=>db.close())

function task(owner='owner') {return store.create({title:'长报告',path:'/tmp/project',providerId:'claude',ownerChatId:owner})}
function control(continued=vi.fn()){
  const handle=makeWechatWorkbenchControl({store,ownerChatId:()=> 'owner',actions:{
    projects:()=>[],createWechat:()=>{throw Error('unused')},setWechatWatch:()=>{},
    detail:id=>({...store.detail(id),inputs:[],permissions:[],questions:[]}),
    continueTask:(id,text)=>{continued(id,text);return store.get(id)},cancel:async id=>store.get(id),
    submitInput:async()=>{throw Error('unused')},resolvePermission:()=>{},resolveAnswer:()=>{},
  }})
  return{continued,handle:async(...args:Parameters<typeof handle>)=>{
    const reply=await handle(...args)
    if(reply!==null&&typeof reply!=='string')throw Error('A result text query unexpectedly delivered a file')
    return reply
  }}
}

describe('immutable WeChat result pages',()=>{
  it('reconstructs long Unicode text from pinned pages and keeps every reply below the transport limit',async()=>{
    const row=task(),text=('段落😀e\u0301'.repeat(1050))+'结尾',eventId=store.addEvent(row.id,'text',text),{handle}=control()
    const status=await handle('owner',`任务 ${row.id} 结果`)
    const token=new RegExp(`任务 ${row.id} 正文 (r${eventId}-[a-f0-9]{12}) 1`).exec(status!)?.[1]
    expect(token).toBe(resultToken({id:eventId,text}))
    const pieces:string[]=[]
    for(let page=1;;page++){
      const reply=await handle('owner',`任务 ${row.id} 正文 ${token} ${page}`)
      expect(reply!.length).toBeLessThanOrEqual(4000)
      const body=/\n\n([\s\S]*?)\n\n(?:上一页|下一页|已到末页)/.exec(reply!)?.[1]
      expect(body).toBeDefined();pieces.push(body!)
      if(reply!.includes('已到末页'))break
    }
    expect(pieces.join('')).toBe(text)
  })

  it('keeps astral Unicode pages within the UTF-16 transport limit without splitting surrogate pairs',async()=>{
    const row=task(),text=('😀正文🧭'.repeat(1400))+'终点🚀',eventId=store.addEvent(row.id,'text',text),token=resultToken({id:eventId,text}),{handle}=control()
    const pieces:string[]=[]
    for(let page=1;;page++){
      const reply=await handle('owner',`任务 ${row.id} 正文 ${token} ${page}`)
      expect(reply!.length).toBeLessThanOrEqual(4000)
      const body=/\n\n([\s\S]*?)\n\n(?:上一页|下一页|已到末页)/.exec(reply!)?.[1]
      expect(body).toBeDefined()
      expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      pieces.push(body!)
      if(reply!.includes('已到末页'))break
    }
    expect(pieces.join('')).toBe(text)
  })

  it('keeps an old event token stable after a newer run adds text',()=>{
    const row=task(),old='旧结果'.repeat(1600),eventId=store.addEvent(row.id,'text',old,null,'old-run'),token=resultToken({id:eventId,text:old})
    const before=wechatResultPage({taskId:row.id,events:store.events(row.id),token,page:2})
    store.addEvent(row.id,'text','新一轮结果',null,'new-run')
    expect(wechatResultPage({taskId:row.id,events:store.events(row.id),token,page:2})).toBe(before)
  })

  it('rejects a token when streaming changes the same event content',()=>{
    const row=task(),text='流式正文'.repeat(1200),eventId=store.addEvent(row.id,'text',text),token=resultToken({id:eventId,text})
    db.query('UPDATE workbench_events SET text=? WHERE id=?').run(text+'更新',eventId)
    expect(wechatResultPage({taskId:row.id,events:store.events(row.id),token,page:1})).toContain('内容已经更新')
  })

  it('rejects missing, foreign and non-text event tokens',()=>{
    const mine=task(),other=task(),foreignText='别人的正文',foreignId=store.addEvent(other.id,'text',foreignText),systemId=store.addEvent(mine.id,'system','内部状态')
    const childId=store.recordAgentEvent(mine.id,'run',{kind:'tool_call',tool:'Agent',activity:{id:'child',type:'agent',status:'completed',label:'子任务',output:'不可展示的子任务输出'}})
    expect(wechatResultPage({taskId:mine.id,events:store.events(mine.id),token:`r${foreignId}-${createHash('sha256').update(foreignText).digest('hex').slice(0,12)}`,page:1})).toContain('不存在或不属于')
    expect(wechatResultPage({taskId:mine.id,events:store.events(mine.id),token:`r${systemId}-${createHash('sha256').update('内部状态').digest('hex').slice(0,12)}`,page:1})).toContain('不存在或不属于')
    const childReply=wechatResultPage({taskId:mine.id,events:store.events(mine.id),token:`r${childId}-${createHash('sha256').update('子任务').digest('hex').slice(0,12)}`,page:1})
    expect(childReply).toContain('不存在或不属于');expect(childReply).not.toContain('不可展示的子任务输出')
    expect(wechatResultPage({taskId:mine.id,events:store.events(mine.id),token:'r999999-aaaaaaaaaaaa',page:1})).toContain('不存在或不属于')
  })

  it('consumes malformed and out-of-range reserved commands without dispatching a supplement',async()=>{
    const row=task(),text='正文'.repeat(1600),eventId=store.addEvent(row.id,'text',text),token=resultToken({id:eventId,text}),{handle,continued}=control()
    const before=store.events(row.id)
    for(const suffix of ['正文','正文 rubbish 1',`正文 ${token} 0`,`正文 ${token} 99`,`正文 ${token} 1 extra`]){
      const reply=await handle('owner',`任务 ${row.id} ${suffix}`)
      expect(reply).toMatch(/正文|用法|页/)
    }
    expect(continued).not.toHaveBeenCalled()
    expect(store.events(row.id)).toEqual(before)
  })
})
