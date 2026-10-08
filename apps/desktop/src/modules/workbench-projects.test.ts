import {expect,it} from 'vitest'
import {renderWorkbench,groupWorkbenchTasks} from './workbench.js'
const project={id:'p-site',name:'个人网站',path:'/work/site',providerId:'codex',createdAt:1}
const state={tasks:[],projects:[project],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null}
it('shows an empty persistent project and a separate add-project entry',()=>{
 const html=renderWorkbench(state)
 expect(html).toContain('个人网站')
 expect(html).toContain('data-action="add-project"')
 expect(html).not.toContain('id="wb-project-form"')
 expect(html).toContain('希望 CC 帮你做什么？')
 expect(renderWorkbench({...state,newScope:'new:add-project'})).toContain('id="wb-project-form"')
 expect(html).not.toContain('id="wb-create-text"')
 expect(groupWorkbenchTasks([],state.projects)).toEqual([{path:project.path,label:project.name,tasks:[]}])
})
it('starts a conversation inside the project without asking for its folder again',()=>{
 const html=renderWorkbench({...state,newScope:'new:/work/site'})
 expect(html).toContain('id="wb-create-form"')
 expect(html).toContain('id="wb-path" name="path" type="hidden" value="/work/site"')
 expect(html).not.toContain('data-action="choose-folder"')
 expect(html).toContain('新对话')
})

it('groups managed tasks together without exposing their UUID folders as projects',()=>{
 const task=(id:string,path:string)=>({id,path,title:id,workspaceKind:'managed' as const,providerId:'codex',status:'completed',createdAt:1,updatedAt:1,error:null})
 const tasks=[task('one','/Tasks/uuid-one'),task('two','/Tasks/uuid-two')]
 const groups=groupWorkbenchTasks(tasks,[project])
 expect(groups).toEqual([{path:'',label:'随手交办',workspaceKind:'managed',tasks},{path:project.path,label:project.name,tasks:[]}])
 const html=renderWorkbench({...state,tasks})
 expect(html).toContain('随手交办')
 expect(html).toContain('data-action="task-entry"')
 expect(html).not.toContain('data-project-path="/Tasks/')
 expect(html).not.toContain('uuid-one')
})
it('allows a first managed entry without adding a project or knowing a local folder',()=>{
 const html=renderWorkbench({...state,projects:[]})
 expect(html).toContain('data-action="task-entry"')
 expect(html).toContain('交给 CC 做')
 expect(html).not.toContain('id="wb-project-form"')
 expect(html).not.toContain('id="wb-path"')
 expect(renderWorkbench({...state,projects:[],newScope:'new:add-project'})).toContain('id="wb-project-form"')
})
it('groups isolated tasks by source and keeps old task paths compatible',()=>{
 const task={id:'one',path:'/copies/one',sourcePath:project.path,title:'副本',providerId:'codex',status:'completed',createdAt:1,updatedAt:1,error:null}
 expect(groupWorkbenchTasks([task],state.projects)).toEqual([{path:project.path,label:project.name,tasks:[task]}])
 const html=renderWorkbench({...state,tasks:[task],selectedId:'one',detail:{task,events:[],artifacts:[],workspace:{id:'ws',mode:'isolated',sourcePath:project.path,executionPath:task.path,branch:'codex/cc-task-x',baseCommit:'a'.repeat(40)}}})
 expect(html).toContain('在独立副本里做');expect(html).toContain('data-action="workspace-export"');expect(html).toContain('data-action="open-task-folder"');expect(html).toContain('归档会保留副本')
 expect(groupWorkbenchTasks([{...task,sourcePath:undefined}],[])[0]?.path).toBe('/copies/one')
})

it('independent-workspace tasks (2026-10-07) are grouped under their source project with a branch badge and actions',()=>{
 const wt={id:'wt1',path:'/state/worktrees/p/abcd1234',title:'并行一件',workspaceKind:'project' as const,providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null,worktree:{branch:'cc/abcd1234',projectPath:'/work/site',removed:false}}
 const groups=groupWorkbenchTasks([wt],[project])
 expect(groups).toEqual([{path:'/work/site',label:'个人网站',tasks:[wt]}])
 const html=renderWorkbench({...state,tasks:[wt]})
 expect(html).toContain('独立分支')
 expect(html).not.toContain('abcd1234</h3>')
 const detail={task:wt,events:[],artifacts:[],permissions:[],questions:[],inputs:[],handoffs:[],wechatNotifications:{enabled:false,notices:[]}}
 const page=renderWorkbench({...state,tasks:[wt],selectedId:'wt1',detail} as never)
 expect(page).toContain('data-action="worktree-commit"');expect(page).toContain('data-action="worktree-remove"');expect(page).toContain('data-action="worktree-merge"');expect(page).not.toContain('已合回项目');expect(page).toContain('cc/abcd1234')
 const merged=renderWorkbench({...state,tasks:[wt],selectedId:'wt1',detail:{...detail,task:{...wt,worktree:{...wt.worktree,merged:true}}}} as never)
 expect(merged).toContain('已合回项目')
 const removed=renderWorkbench({...state,tasks:[{...wt,worktree:{...wt.worktree,removed:true}}],selectedId:'wt1',detail:{...detail,task:{...wt,worktree:{...wt.worktree,removed:true}}}} as never)
 expect(removed).not.toContain('data-action="worktree-commit"');expect(removed).toContain('工作区已删除')
})

it('sourcePath takes priority over legacy projection and workspace detail retains explicit actions',()=>{
 const task={id:'new',path:'/copy/execution',sourcePath:'/work/source',title:'新副本',workspaceKind:'project' as const,providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null,worktree:{branch:'old-branch',projectPath:'/old-source',removed:false}}
 const workspace={id:'ws-new',mode:'isolated' as const,sourcePath:'/work/source',executionPath:task.path,branch:'codex/cc-task-new',baseCommit:'b'.repeat(40)}
 expect(groupWorkbenchTasks([task],[])[0]?.path).toBe('/work/source')
 const detail={task,events:[],artifacts:[],workspace}
 const page=renderWorkbench({...state,tasks:[task],selectedId:task.id,detail})
 expect(page).toContain('ws-new');expect(page).toContain(workspace.branch);expect(page).toContain(workspace.executionPath)
 expect(page.match(/data-action="worktree-commit"/g)).toHaveLength(1)
 expect(page.match(/data-action="worktree-remove"/g)).toHaveLength(1)
 expect(page).not.toContain('data-action="worktree-merge"')
 expect(page).not.toContain('old-branch</code>')
 const removed=renderWorkbench({...state,tasks:[task],selectedId:task.id,detail:{...detail,workspace:{...workspace,removed:true}}})
 expect(removed).not.toContain('data-action="worktree-commit"');expect(removed).not.toContain('data-action="worktree-remove"')
 expect(removed).toContain('工作区已删除（分支还在项目里）')
})
