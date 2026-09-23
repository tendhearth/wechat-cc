import {expect,it,vi} from 'vitest'
import {createWorkbenchThumbnails,isThumbnailImage} from './workbench-thumbnails.js'
it('loads through scoped API once, keeps tasks isolated, and revokes owned URLs',async()=>{
 const revoke=vi.spyOn(URL,'revokeObjectURL'),invoke=vi.fn(async()=>({attachment:{id:'image',mime:'image/png'},base64:'aGVsbG8='}))
 const manager=createWorkbenchThumbnails({invoke})
 try{
  const [a,b]=await Promise.all([manager.load('taskA','image'),manager.load('taskA','image')])
  expect(a).toBe(b);expect(invoke).toHaveBeenCalledTimes(1)
  const c=await manager.load('taskB','image');expect(c).not.toBe(a)
  expect(invoke.mock.calls[1]).toEqual(['GET','/v1/workbench/attachment?taskId=taskB&id=image'])
  manager.destroy();expect(revoke).toHaveBeenCalledWith(a);expect(revoke).toHaveBeenCalledWith(c)
 }finally{manager.destroy();revoke.mockRestore()}
})
it('retries failed reads and rejects active or mismatched content',async()=>{
 const invoke=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({attachment:{id:'image',mime:'image/png'},base64:'YQ=='}).mockResolvedValue({attachment:{id:'wrong',mime:'image/svg+xml'},base64:'YQ=='})
 const manager=createWorkbenchThumbnails({invoke})
 try{
  await expect(manager.load('task','image')).rejects.toThrow('offline')
  expect(await manager.load('task','image')).toMatch(/^blob:/)
  await expect(manager.load('task','other')).rejects.toThrow('invalid_image')
  expect(isThumbnailImage('image/svg+xml')).toBe(false)
 }finally{manager.destroy()}
})
it('does not allocate an image URL after the page is disposed',async()=>{
 let finish!:(value:unknown)=>void
 const manager=createWorkbenchThumbnails({invoke:()=>new Promise(resolve=>{finish=resolve})})
 const pending=manager.load('task','image');manager.destroy()
 finish({attachment:{id:'image',mime:'image/png'},base64:'YQ=='})
 await expect(pending).rejects.toThrow('disposed')
})
it('keeps generated images beside their earlier reply when a later reply arrives',async()=>{
 const {renderWorkbench}=await import('./workbench.js')
 const task={id:'deadbeef',title:'images',path:'/work',providerId:'codex',status:'completed',createdAt:1,updatedAt:5,error:null}
 const html=renderWorkbench({tasks:[task],providers:[],defaultProvider:null,canWechat:false,selectedId:task.id,selectedArtifactId:null,error:'',preview:null,detail:{task,events:[{id:'1',taskId:task.id,kind:'text',text:'Here is the image',createdAt:2},{id:'2',taskId:task.id,kind:'text',text:'A later reply',createdAt:4}],artifacts:[{id:'artifact-one',taskId:task.id,name:'drawing.png',mime:'image/png',size:4,sha256:'a'.repeat(64),createdAt:3,approvedAt:null}]}})
 expect(html.indexOf('data-thumbnail-kind="artifact"')).toBeGreaterThan(html.indexOf('Here is the image'))
 expect(html.indexOf('data-thumbnail-kind="artifact"')).toBeLessThan(html.indexOf('A later reply'))
})
