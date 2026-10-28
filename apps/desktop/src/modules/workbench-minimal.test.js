// @vitest-environment happy-dom
import {afterEach,describe,expect,it} from 'vitest'
import {renderWorkbench} from './workbench.js'

const task={id:'A',title:'验证本地修改',path:'/work/project',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount:2,pendingQuestionCount:1}
const permission=id=>({id,taskId:'A',tool:'Bash',description:`bun run test -- ${id}\ncwd: /work/project\n仅允许这一次请求`,createdAt:1})
const state={tasks:[task],providers:[],defaultProvider:'codex',selectedId:'A',selectedArtifactId:null,preview:null,error:'',canWechat:false,detail:{task,events:[],artifacts:[],permissions:[permission('p1'),permission('p2')],questions:[{id:'q1',taskId:'A',createdAt:1,questions:[{id:'q',header:'验证',question:'先验证哪个页面？',options:[]}]}]}}
afterEach(()=>{document.body.innerHTML=''})
const render=value=>{document.body.innerHTML=renderWorkbench(value);return document.body}

describe('workbench decision hierarchy in the rendered page',()=>{
 it('keeps the decision instruction in its action area and counts both permission and question requests quietly elsewhere',()=>{
  const root=render(state),row=root.querySelector('[data-task-id="A"]'),marker=row.querySelector('.wb-task-attention'),jump=root.querySelector('[data-action="show-decisions"]')
  expect(marker.textContent.trim()).toBe('3')
  expect(marker.getAttribute('aria-label')).toContain('2 项权限请求等你确认')
  expect(marker.getAttribute('aria-label')).toContain('1 项问题等你回答')
  expect(marker.title).toContain('2 项权限请求等你确认')
  expect(row.getAttribute('aria-label')).toContain('1 项问题等你回答')
  expect(jump.textContent.trim()).toBe('3')
  expect(jump.getAttribute('aria-label')).toContain('3 项等你处理')
  expect(jump.title).toContain('3 项等你处理')
  expect(root.querySelectorAll('.wb-permissions h3')).toHaveLength(1)
  expect(root.querySelector('.wb-permissions h3').textContent).toBe('需要你的决定')
  expect(root.querySelector('.wb-task-head').textContent).not.toContain('等你处理')
  for(const id of ['p1','p2']){
   const article=root.querySelector(`[data-request-id="${id}"]`).closest('article')
   expect(article.querySelector('p').textContent).toBe(`bun run test -- ${id}\ncwd: /work/project\n仅允许这一次请求`)
   expect(article.querySelector('[data-action="deny-permission"]').textContent).toBe('拒绝')
   expect(article.querySelector('[data-action="allow-permission"]').textContent).toBe('允许')
  }
  expect(root.querySelector('.wb-questions').textContent).toContain('先验证哪个页面？')
 })

 it.each([
  ['failed',{},'未完成'],['completed',{},'已完成'],['running',{importedOnly:true},'尚未执行'],
  ['queued',{waitingFor:{taskId:'B',title:'前项',reason:'writer_not_closed'}},'等待执行程序退出确认'],
  ['unknown',{},'unknown'],
 ])('preserves the distinct %s list state when there are no pending requests',(status,extra,label)=>{
  const current={...task,status,...extra,pendingPermissionCount:0,pendingQuestionCount:0}
  const row=render({...state,tasks:[current],detail:null}).querySelector('[data-task-id="A"]')
  expect(row.querySelector('.wb-status').textContent).toBe(label)
  expect(row.querySelector('.wb-task-attention')).toBeNull()
 })
})
