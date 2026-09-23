import { describe, expect, it } from 'vitest'
import { renderWorkbench } from './workbench.js'
import { captureWorkbenchTimelineAnchor } from './workbench-timeline.js'

type Activity = { id:string, type:'command'|'read'|'edit'|'search'|'tool'|'agent', status:'running'|'completed'|'failed'|'cancelled'|'interrupted', label:string, detail?:string, parentId?:string, agentIds?:string[] }
type Event = { id:string, taskId:string, kind:'user'|'text'|'tool_call'|'system'|'error', text:string, createdAt:number, runId?:string, activity?:Activity }
const event = (id:string, kind:Event['kind'], text:string, extra:Partial<Event> = {}):Event => ({ id, taskId:'A', kind, text, createdAt:1, ...extra })
const operation = (id:string, type:Activity['type'], label:string, status:Activity['status'] = 'running', extra:Partial<Event> = {}):Event => event(id, 'tool_call', label, { runId:'current', activity:{ id, type, status, label }, ...extra })
const render = (events:Event[], status = 'running', runId:string|undefined = 'current') => renderWorkbench({
  tasks:[], providers:[{ id:'codex', displayName:'Codex' }], defaultProvider:'codex', canWechat:false, selectedId:'A', selectedArtifactId:null, error:'', preview:null,
  detail:{ task:{ id:'A', title:'Timeline', path:'/work', providerId:'codex', status, createdAt:1, updatedAt:2, error:null }, events, artifacts:[], runId },
})
const foldedGroups = (html:string) => [...html.matchAll(/<details\b[^>]*data-timeline-group[^>]*>/g)].map(match => match[0])
const visibleWithoutGroups = (html:string) => html.replace(/<details\b[^>]*data-timeline-group[^>]*>[\s\S]*?<\/details>/g, '')

describe('workbench interleaved activity timeline', () => {
  it('anchors the readable reply rather than a short adjacent activity row, falling back to operations when no reply is visible', () => {
    const operation = { id:'operation', classList:{ contains:() => false }, getBoundingClientRect:() => ({ top:10, bottom:30, height:20 }) }
    const reply = { id:'reply', classList:{ contains:(name:string) => name === 'wb-message' }, getBoundingClientRect:() => ({ top:50, bottom:170, height:120 }) }
    const content = { getBoundingClientRect:() => ({ top:0, bottom:400, height:400 }) }
    expect(captureWorkbenchTimelineAnchor({ querySelectorAll:() => [operation,reply] } as any, content as any)).toEqual({ id:'reply', offset:50 })
    expect(captureWorkbenchTimelineAnchor({ querySelectorAll:() => [operation] } as any, content as any)).toEqual({ id:'operation', offset:10 })
  })
  it('keeps replies and operations in arrival order rather than sorting timestamps or collecting a tool appendix', () => {
    const html = render([
      event('reply1', 'text', 'First explanation', { createdAt:30, runId:'current' }),
      operation('read1', 'read', 'Read source', 'running', { createdAt:10 }),
      event('reply2', 'text', 'Next explanation', { createdAt:20, runId:'current' }),
      operation('test1', 'command', 'Run focused tests'),
    ])
    expect(html.indexOf('First explanation')).toBeLessThan(html.indexOf('Read source'))
    expect(html.indexOf('Read source')).toBeLessThan(html.indexOf('Next explanation'))
    expect(html.indexOf('Next explanation')).toBeLessThan(html.indexOf('Run focused tests'))
    expect(foldedGroups(html)).toHaveLength(0)
    expect(html).toContain('data-status="running"')
    expect(html).not.toContain('id="wb-tools"')
  })

  it('folds each consecutive group in its original position only after the run ends, with deterministic operation counts', () => {
    const events = [event('a', 'text', 'Before operations'), operation('r1', 'read', 'Read one', 'completed'), operation('r2', 'read', 'Read two', 'completed'), operation('c', 'command', 'Run tests', 'completed'), event('b', 'text', 'Between groups'), operation('s', 'search', 'Find symbol', 'completed'), event('z', 'text', 'Final answer')]
    expect(foldedGroups(render(events))).toHaveLength(0)
    expect(foldedGroups(render(events, 'cancelling'))).toHaveLength(0)
    const html = render(events, 'completed')
    expect(foldedGroups(html)).toHaveLength(2)
    expect(foldedGroups(html).every(tag => !/\sopen(?:\s|=|>)/.test(tag))).toBe(true)
    expect(html).toContain('读取 2')
    expect(html).toContain('命令 1')
    expect(html).toContain('搜索 1')
    expect(html.indexOf('Read one')).toBeLessThan(html.indexOf('Between groups'))
    expect(html.indexOf('Between groups')).toBeLessThan(html.indexOf('Find symbol'))
    const visible = visibleWithoutGroups(html)
    for (const reply of ['Before operations', 'Between groups', 'Final answer']) expect(visible).toContain(reply)
    expect(visible).not.toContain('Read one')
  })

  it('keeps a historical run folded while the current run executes, even for consecutive operations', () => {
    const html = render([
      operation('old', 'read', 'Historical read', 'completed', { runId:'previous' }),
      operation('new', 'command', 'Current command'),
    ])
    expect(foldedGroups(html)).toHaveLength(1)
    expect(visibleWithoutGroups(html)).not.toContain('Historical read')
    expect(visibleWithoutGroups(html)).toContain('Current command')
    expect(foldedGroups(render([operation('old', 'read', 'Historical read', 'completed', { runId:'previous' })], 'queued', undefined))).toHaveLength(1)
  })

  it('updates an activity at its first arrival position and scopes reused provider IDs to their run', () => {
    const first = operation('read1', 'read', 'Reading source')
    const completed = event('update1', 'tool_call', 'Read source', { runId:'current', activity:{ ...first.activity!, status:'completed', label:'Read source' } })
    const html = render([first, event('reply', 'text', 'Explanation during read'), completed, operation('old-row', 'read', 'Other run read', 'completed', { runId:'previous', activity:{ ...first.activity!, status:'completed', label:'Other run read' } })])
    expect(html.match(/class="wb-operation-label">Read source</g)).toHaveLength(1)
    expect(html).not.toContain('Reading source')
    expect(html.indexOf('Read source')).toBeLessThan(html.indexOf('Explanation during read'))
    expect(html).toContain('Other run read')
    const firstId = render([first], 'completed').match(/<details\b[^>]*id="([^"]+)"[^>]*data-timeline-group/)?.[1]
    const completedId = render([first, completed], 'completed').match(/<details\b[^>]*id="([^"]+)"[^>]*data-timeline-group/)?.[1]
    expect(firstId).toBeTruthy()
    expect(completedId).toBe(firstId)
  })

  it('leaves failed operations and error text visible between folded groups and escapes all activity fields', () => {
    const html = render([
      operation('ok', 'read', 'Earlier read', 'completed'),
      operation('bad"', 'command', '<img src=x onerror=alert(1)>', 'failed', { activity:{ id:'bad"', type:'command', status:'failed', label:'<img src=x onerror=alert(1)>', detail:'<script>failure()</script>' } }),
      event('error', 'error', 'Execution failed <unsafe>'),
      operation('after', 'tool', 'Cleanup record', 'completed'),
      event('reply', 'text', 'Visible conclusion'),
    ], 'failed')
    const visible = visibleWithoutGroups(html)
    expect(visible).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(visible).toContain('&lt;script&gt;failure()&lt;/script&gt;')
    expect(visible).toContain('Execution failed &lt;unsafe&gt;')
    expect(visible).toContain('data-status="failed"')
    expect(visible).toContain('role="alert"')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html.indexOf('Earlier read')).toBeLessThan(html.indexOf('Execution failed'))
    expect(html.indexOf('Execution failed')).toBeLessThan(html.indexOf('Cleanup record'))
  })

  it('keeps legacy operations readable without inferring a completed state and renders agents as ordinary activity rows', () => {
    const legacy = render([event('legacy', 'tool_call', 'Shell: inspect files')], 'completed')
    expect(legacy).toContain('Shell: inspect files')
    expect(legacy).not.toMatch(/class="wb-operation[^>]*data-status="completed"/)
    const html = render([operation('agent', 'agent', 'Review dependencies', 'running', { activity:{ id:'agent', type:'agent', status:'running', label:'Review dependencies', detail:'Check <dependencies>', parentId:'parent"', agentIds:['worker<1>'] } })])
    expect(html).toContain('class="wb-operation-label">Review dependencies</')
    expect(html).toContain('data-activity-type="agent"')
    expect(html).toContain('Check &lt;dependencies&gt;')
    expect(html).toContain('worker&lt;1&gt;')
    expect(html).toMatch(/<details[^>]*data-timeline-disclosure/)
    expect(html).toMatch(/class="wb-operation-type">[\s\S]*?<svg[^>]*width="13"[^>]*aria-hidden="true"/)
    expect(html).toContain('<span class="wb-sr-only">协作</span>')
  })
})
