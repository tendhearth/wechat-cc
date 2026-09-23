import {expect,it} from 'vitest'
import {renderWorkbench,groupWorkbenchTasks} from './workbench.js'
const project={id:'p-site',name:'个人网站',path:'/work/site',providerId:'codex',createdAt:1}
const state={tasks:[],projects:[project],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null}
it('shows an empty persistent project and a separate add-project entry',()=>{
 const html=renderWorkbench(state)
 expect(html).toContain('个人网站')
 expect(html).toContain('data-action="add-project"')
 expect(html).toContain('id="wb-project-form"')
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
