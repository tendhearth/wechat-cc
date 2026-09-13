import {describe,expect,it} from 'vitest'
import {renderWorkbench} from './workbench.js'
import type {AgentRuntimeSnapshot} from '../../../../src/core/agent-provider'

const runtime:AgentRuntimeSnapshot={retained:true,foreground:'idle',backgroundCount:0,input:'send'}
function render(observed=runtime,status='running'){
  const task={id:'A',title:'Native task',path:'/project',providerId:'claude',status,createdAt:1,updatedAt:2,error:null,runtime:observed}
  return renderWorkbench({tasks:[task],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false,selectedId:'A',selectedArtifactId:null,error:'',preview:null,
    detail:{task,runtime:observed,runId:'epoch',inputMode:observed.input,events:[
      {id:'1',taskId:'A',runId:'epoch',kind:'text',text:'主回复先到',createdAt:1},
      {id:'2',taskId:'A',runId:'epoch',kind:'tool_call',text:'校对',createdAt:2,activity:{id:'child:turn-1',type:'agent',label:'校对子助手',status:'completed',output:'<script>child()</script>'}},
      {id:'3',taskId:'A',runId:'epoch',kind:'text',text:'后来收到的汇总',createdAt:3},
    ],artifacts:[]}})
}

describe('retained workbench runtime presentation',()=>{
  it('shows retention in the list and detail without claiming complete or showing active status',()=>{
    const html=render()
    expect(html.match(/会话保留中/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('data-status="retained"')
    expect(html).not.toMatch(/class="wb-status" data-status="running"/)
    expect(html).toContain('后续回复会继续出现在这里')
    expect(html).toContain('结束后台会话')
    expect(html).toContain('停止尚未结束的后台工作')
    expect(html).toContain('data-action="send-input"')
    expect(html).not.toContain('加入下一轮')
    expect(html).toContain('同一会话')
  })
  it('shows observed background work and does not hide a later cancellation behind retained state',()=>{
    const working=render({...runtime,backgroundCount:2})
    expect(working).toContain('后台执行中 · 2')
    expect(working).not.toContain('会话保留中')
    const cancelling=render(runtime,'cancelling')
    expect(cancelling).toContain('正在停止')
    expect(cancelling).not.toContain('data-status="retained"')
    expect(cancelling).not.toContain('data-action="send-input"')
    expect(render({...runtime,foreground:'unknown'})).not.toContain('data-status="retained"')
  })
  it('does not promise automatic next-turn delivery when a retained executor cannot accept input',()=>{
    const html=render({...runtime,input:'queue'})
    expect(html).toContain('保存补充')
    expect(html).toContain('不会自动发送')
    expect(html).not.toContain('加入下一轮')
    expect(html).not.toContain('本轮正常结束后')
  })
  it('folds settled operations in retained idle while preserving main reply order and escaped child output',()=>{
    const html=render()
    expect(html).toMatch(/<details[^>]*data-timeline-group/)
    expect(html).toMatch(/data-timeline-disclosure><summary>查看子助手回复<\/summary>/)
    expect(html).toContain('&lt;script&gt;child()&lt;/script&gt;')
    expect(html).not.toContain('<script>child()')
    expect(html.indexOf('主回复先到')).toBeLessThan(html.indexOf('校对子助手'))
    expect(html.indexOf('校对子助手')).toBeLessThan(html.indexOf('后来收到的汇总'))
  })
})
