// @vitest-environment happy-dom
import {expect,it} from 'vitest'
import {renderWorkbench} from './workbench.js'
import {taskDetailLabel,statusOf} from '../../../app/src/view/status'
it.each([
 ['queued','queued',undefined,'等待中','Queued'],
 ['cancelling','working',undefined,'正在停止','Stopping'],
 ['running','working',{since:1},'已暂停(网络未受保护)','Paused (network unprotected)'],
] as const)('desktop/App agree on %s task observations',(status,phase,networkSuspended,zh,en)=>{
 const task={id:'A',title:'同一任务',path:'',providerId:'codex',status,phase,networkSuspended,createdAt:1,updatedAt:1,error:null}
 document.body.innerHTML=renderWorkbench({tasks:[],providers:[],defaultProvider:null,canWechat:false,selectedArtifactId:null,error:'',preview:null,selectedId:'A',detail:{task,events:[],permissions:[],questions:[],artifacts:[]}})
 expect(document.querySelector('.wb-task-progress .wb-status')?.textContent).toBe(zh)
 expect(taskDetailLabel(task,0,'zh-Hans')).toBe(zh)
 expect(taskDetailLabel(task,0,'en')).toBe(en)
 expect(statusOf(task,0)).toBe('working')
 expect(taskDetailLabel(task,1,'en')).toBe('Waiting on you')
})
