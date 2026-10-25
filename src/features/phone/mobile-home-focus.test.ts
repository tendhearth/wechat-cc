import {describe,it,expect} from 'vitest'
import {mobileHomeFocus} from './mobile-home-focus'

const matter=(id:string)=>({id,kind:'task',title:id,status:'open',updatedAt:Date.now()})
const detail=(id:string,extra:Record<string,unknown>={})=>({matter:matter(id),task:{id,status:'running'},runId:'r1',permissions:[],questions:[],artifacts:[],...extra})
describe('mobile home focus uses actual tasks',()=>{
  it('prioritizes a pending decision over a completed result without exposing task internals',async()=>{
    const rows=[matter('aaaaaaaa'),matter('bbbbbbbb')]
    const result=await mobileHomeFocus({list:()=>rows,detail:id=>id==='aaaaaaaa'?detail(id,{task:{id,status:'completed'},artifacts:[{id:'art',taskId:id,name:'report.png'}]}):detail(id,{permissions:[{id:'p',taskId:id,description:'private command'}]})})
    expect(result).toEqual({focus:{id:'bbbbbbbb',title:'bbbbbbbb',kind:'decision'},partial:false})
    expect(JSON.stringify(result)).not.toContain('private command')
  })
  it('does not treat a failed task with a saved file as successful',async()=>{
    expect(await mobileHomeFocus({list:()=>[matter('aaaaaaaa')],detail:id=>detail(id,{task:{id,status:'failed'},artifacts:[{taskId:id,name:'partial.png'}]})})).toEqual({focus:null,partial:false})
  })
  it('ignores foreign requests and reports unavailable detail instead of saying everything is quiet',async()=>{
    const result=await mobileHomeFocus({list:()=>[matter('aaaaaaaa'),matter('bbbbbbbb')],detail:id=>{if(id==='bbbbbbbb')throw Error('gone');return detail(id,{permissions:[{id:'p',taskId:'bbbbbbbb'}]})}})
    expect(result).toEqual({focus:{id:'aaaaaaaa',title:'aaaaaaaa',kind:'working'},partial:true})
  })
  it('missing source is explicitly unavailable',async()=>{
    expect(await mobileHomeFocus(undefined)).toEqual({focus:null,partial:true})
  })
  it('shows a recent result but leaves old completed work out of Now',async()=>{
    const source={list:()=>[matter('aaaaaaaa')],detail:(id:string)=>detail(id,{task:{id,status:'completed'},artifacts:[{taskId:id,name:'report.png'}]})}
    expect((await mobileHomeFocus(source)).focus?.kind).toBe('result')
    source.list=()=>[{...matter('aaaaaaaa'),updatedAt:Date.now()-48*60*60*1000}]
    expect((await mobileHomeFocus(source)).focus).toBeNull()
  })
})
