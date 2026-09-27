import {expect,it} from 'vitest'
import {openTestDb} from '../../lib/db'
import {makeWorkbenchStore} from './store'

it('keeps managed workspaces out of both stored and history-derived project choices',()=>{
 const db=openTestDb()
 try{
  const store=makeWorkbenchStore(db)
  const legacy=store.create({title:'project',path:'/work/site',providerId:'claude',ownerChatId:'owner'})
  const projects=store.projects(),owned=store.ownedProjects('owner',['claude'])
  const managed=store.create({title:'draft',path:'/tasks/random',providerId:'claude',ownerChatId:'owner',workspaceKind:'managed',registerProject:false})
  expect(store.projects()).toEqual(projects)
  expect(store.ownedProjects('owner',['claude'])).toEqual(owned)
  expect(store.ownedProjects('owner')).toEqual(owned)
  expect(store.get(managed.id).workspaceKind).toBe('managed')
  expect(store.get(legacy.id).workspaceKind).toBe('project')
  expect(store.listPage().tasks.find(task=>task.id===managed.id)?.workspaceKind).toBe('managed')
 }finally{db.close()}
})

it('keeps empty projects and independent conversations through archive and store recreation',()=>{
 const db=openTestDb()
 try{
  const store=makeWorkbenchStore(db)
  const project=store.addProject({path:'/work/site',name:'个人网站',providerId:'codex'})
  expect(store.listPage().tasks).toEqual([])
  expect(store.projects()).toEqual([project])
  expect(store.addProject({path:project.path,name:'duplicate',providerId:'claude'}).id).toBe(project.id)
  const a=store.create({path:project.path,title:'首页',providerId:'codex',ownerChatId:null})
  const b=store.create({path:project.path,title:'修复',providerId:'claude',ownerChatId:null})
  expect(store.listPage({q:'个人网站'}).tasks).toHaveLength(2)
  store.addEvent(a.id,'user','only in first conversation')
  expect(store.events(b.id)).toEqual([])
  for(const task of [a,b]){store.update(task.id,'completed');store.setArchived(task.id,true)}
  const reopened=makeWorkbenchStore(db)
  expect(reopened.listPage().tasks).toEqual([])
  expect(reopened.projects()).toHaveLength(1)
  expect(reopened.projects()[0]).toMatchObject({id:project.id,name:'个人网站',path:'/work/site'})
 }finally{db.close()}
})
it('creates one durable project for legacy path-based task callers',()=>{
 const db=openTestDb()
 try{
  const store=makeWorkbenchStore(db)
  for(const title of ['one','two'])store.create({title,path:'/work/legacy',providerId:'claude',ownerChatId:null})
  expect(store.projects()).toHaveLength(1)
  expect(store.projects()[0]).toMatchObject({name:'legacy',path:'/work/legacy'})
 }finally{db.close()}
})
