import { describe, expect, it } from 'vitest'
import { groupActivity, initialSession, mergeActivity, placeSessions, splitSessions, terminalInputReason } from './thing-thread-model.js'
import type { Activity, Place, RosterItem, Session } from './thing-thread-model.js'

function activity(id: string, kind: Activity['kind'] = 'step', at: number | null = null): Activity {
  return {id,kind,at,text:id}
}

const rosterItem = (id:string,updatedAt:number,group:RosterItem['group']='back'):RosterItem => ({
  key:'terminal:'+id, id, updatedAt, group, status:group === 'waiting' ? 'waiting' : 'replied',
  kind:'terminal', title:id, agents:[], quiet:false, unseen:false,
})

describe('桌面一件事', () => {
  it('只合并连续的步，跨天仍分开', () => {
    const day = new Date(2026,10,20,12).getTime()
    const items = [activity('a','you',day),activity('b','step',day),activity('c'),activity('d','step',day+86400000),activity('e','said')]
    expect(groupActivity(items).map(group => group.map(item => item.id))).toEqual([['a'],['b','c'],['d'],['e']])
    expect(groupActivity([])).toEqual([])
  })

  it('按最近活动排序，只先露六次，保留较早的次数和顺序', () => {
    const place: Place = {key:'p:test', name:'工作区', line:null, status:null, waiting:null, unseen:false,
      moving:false,updatedAt:null,matterIds:['task'],messageIds:[],sessionIds:['a','b','c','d','e','f']}
    const task:RosterItem = {...rosterItem('task',12), key:'matter:task', kind:'matter'}
    const items = placeSessions(place,[rosterItem('a',0),rosterItem('b',3),rosterItem('c',9),
      rosterItem('d',6),rosterItem('e',2),rosterItem('f',1),rosterItem('g',99),task])
    const {visible,earlier} = splitSessions(items)
    expect(visible.map(item=>item.id)).toEqual(['task','c','d','b','e','f'])
    expect(earlier.map(item=>item.id)).toEqual(['a'])
  })

  it('先用本窗口记住的，再用在等你定的，最后按最近活动', () => {
    const recent = rosterItem('recent',20), waiting = rosterItem('ask',10,'waiting')
    expect(initialSession([recent,waiting])?.id).toBe('ask')
    expect(initialSession([recent,waiting],recent.key)?.id).toBe('recent')
    expect(initialSession([recent],'lost')?.id).toBe('recent')
    expect(initialSession([])).toBeUndefined()
  })

  it('运行中只在窗口开着时能送话，等待和结束说明原因', () => {
    const session: Session = {session_id:'s',code:'xx',source:'codex',status:'idle',stale:false,project:'工作区',
      machine:null,last_summary:null,last_event_at:1,last_prompt_at:null,created_at:1,pending:null}
    expect(terminalInputReason(session,'Codex',false)).toBe('')
    expect(terminalInputReason({...session,status:'running',live_window:true},'Codex',false)).toBe('')
    expect(terminalInputReason({...session,status:'running'},'Codex',false)).toBe('Codex 正在做，等这一轮停了再说')
    expect(terminalInputReason({...session,status:'waiting'},'Codex',true)).toBe('先定上面这件，它才往下走')
    expect(terminalInputReason({...session,stale:true,live_window:true},'Codex',false)).toBe('')
    expect(terminalInputReason({...session,stale:true,live_window:false},'Codex',false)).toBe('它的窗口不在了，回终端里接着说')
    expect(terminalInputReason({...session,status:'ended'},'Codex',false)).toBe('这次会话已经结束，接着做要在终端里重新打开')
  })

  it('翻页加在前面，最新页接在后面，重叠的 ID 原位更新', () => {
    const [a,b,c,d,e] = ['x','k','n','h','l'].map(id => activity(id)) as [Activity,Activity,Activity,Activity,Activity]
    const older = mergeActivity([c,d],[a,b,{...c,error:true}],'earlier')
    expect(older).toEqual([a,b,{...c,error:true},d])
    expect(mergeActivity(older,[{...d,detail:'结果'},e],'latest')).toEqual([a,b,{...c,error:true},{...d,detail:'结果'},e])
    expect(mergeActivity([d],[a,b],'earlier')).toEqual([a,b,d])
    expect(mergeActivity([d],[e],'latest')).toEqual([d,e])
    expect(mergeActivity([d],[c,d,e],'latest')).toEqual([c,d,e])
  })
})
