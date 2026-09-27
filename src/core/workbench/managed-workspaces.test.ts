import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {removeTempDir} from '../../lib/test-temp'
import {createManagedWorkspaces} from './managed-workspaces'

let base:string,root:string,stateDir:string
beforeEach(()=>{
  base=realpathSync(mkdtempSync(join(tmpdir(),'cc-managed-workspaces-')))
  root=join(base,'CC','Tasks');stateDir=join(base,'state');mkdirSync(stateDir)
})
afterEach(()=>removeTempDir(base))
const reservation=(workspaceId=randomUUID())=>({workspaceId,resolvedPath:null,directoryIdentity:null})
const identity=(path:string)=>{const stat=lstatSync(path,{bigint:true});return `${stat.dev}:${stat.ino}`}
const link=(target:string,path:string)=>symlinkSync(target,path,'junction')

describe('managed workspace allocation',()=>{
  it('creates private sibling directories from server-issued workspace identities',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),a=reservation(),b=reservation()
    const first=manager.ensure(a),second=manager.ensure(b)
    expect(first).toEqual({id:a.workspaceId,path:join(root,a.workspaceId),directoryIdentity:identity(join(root,a.workspaceId)),created:true})
    expect(second.path).toBe(join(root,b.workspaceId));expect(second.path).not.toBe(first.path)
    if(process.platform!=='win32')expect(lstatSync(first.path).mode&0o777).toBe(0o700)
    expect(()=>manager.verify(first)).not.toThrow()
  })

  it('reuses a registered directory after restart even when the task has written files',()=>{
    const first=createManagedWorkspaces({root,stateDir}).ensure(reservation())
    writeFileSync(join(first.path,'draft.txt'),'retain')
    const manager=createManagedWorkspaces({root,stateDir})
    const retried=manager.ensure({workspaceId:first.id,resolvedPath:first.path,directoryIdentity:first.directoryIdentity})
    expect(retried).toEqual({...first,created:false});expect(manager.removeEmptyCreated(retried)).toBe(false)
    expect(readFileSync(join(first.path,'draft.txt'),'utf8')).toBe('retain')
  })

  it('adopts only an empty reserved directory from the crash window before inode registration',()=>{
    const request=reservation(),path=join(root,request.workspaceId);mkdirSync(path,{recursive:true})
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(request)
    expect(workspace).toEqual({id:request.workspaceId,path,directoryIdentity:identity(path),created:false})
    expect(manager.removeEmptyCreated(workspace)).toBe(false);expect(existsSync(path)).toBe(true)
  })

  it.skipIf(process.platform==='win32')('makes an adopted empty directory private before handing it to a task',()=>{
    const request=reservation(),path=join(root,request.workspaceId);mkdirSync(path,{recursive:true});chmodSync(path,0o755)
    const workspace=createManagedWorkspaces({root,stateDir}).ensure(request)
    expect(workspace.created).toBe(false);expect(lstatSync(path).mode&0o777).toBe(0o700)
  })

  it('preserves unknown content in a reserved directory whose identity was never registered',()=>{
    const request=reservation(),path=join(root,request.workspaceId);mkdirSync(path,{recursive:true});writeFileSync(join(path,'unknown'),'keep')
    expect(()=>createManagedWorkspaces({root,stateDir}).ensure(request)).toThrow('managed_workspace_changed')
    expect(readFileSync(join(path,'unknown'),'utf8')).toBe('keep')
  })

  it('does not recreate a missing directory after its identity was registered',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation())
    renameSync(workspace.path,workspace.path+'-saved')
    expect(()=>manager.ensure({workspaceId:workspace.id,resolvedPath:workspace.path,directoryIdentity:workspace.directoryIdentity})).toThrow('managed_workspace_changed')
    expect(existsSync(workspace.path)).toBe(false)
  })

  it('rejects a replacement directory on ensure and verify without removing either directory',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation())
    renameSync(workspace.path,workspace.path+'-saved');mkdirSync(workspace.path)
    expect(()=>manager.ensure({workspaceId:workspace.id,resolvedPath:workspace.path,directoryIdentity:workspace.directoryIdentity})).toThrow('managed_workspace_changed')
    expect(()=>manager.verify(workspace)).toThrow('managed_workspace_changed')
    expect(manager.removeEmptyCreated(workspace)).toBe(false)
    expect(existsSync(workspace.path)).toBe(true);expect(existsSync(workspace.path+'-saved')).toBe(true)
  })

  it.each(['../outside','123e4567-e89b-12d3-a456-426614174000','not-a-uuid',null])('refuses invalid workspace identity %s before creating directories',workspaceId=>{
    expect(()=>createManagedWorkspaces({root,stateDir}).ensure({...reservation(),workspaceId})).toThrow('invalid_managed_workspace')
    expect(existsSync(root)).toBe(false)
  })

  it('does not accept an arbitrary persisted path or an identity without its persisted path',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),request=reservation()
    for(const resolvedPath of [stateDir,join(root,'other'),join(root,request.workspaceId,'nested')])expect(()=>manager.ensure({...request,resolvedPath})).toThrow('invalid_managed_workspace')
    expect(()=>manager.ensure({...request,directoryIdentity:'1:2'})).toThrow('invalid_managed_workspace')
    expect(existsSync(root)).toBe(false)
  })
})

describe('managed workspace boundaries',()=>{
  it.each(['same','inside','around'] as const)('refuses %s overlap with daemon state before creating directories',shape=>{
    const unsafeRoot=shape==='same'?stateDir:shape==='inside'?join(stateDir,'tasks'):base
    expect(()=>createManagedWorkspaces({root:unsafeRoot,stateDir}).ensure(reservation())).toThrow('invalid_managed_workspace')
    expect(existsSync(join(stateDir,'tasks'))).toBe(false)
  })

  it('allows sibling paths with a shared textual prefix',()=>{
    const manager=createManagedWorkspaces({root:stateDir+'-tasks',stateDir})
    expect(manager.ensure(reservation()).path.startsWith(stateDir+'-tasks')).toBe(true)
  })

  it.each(['.cc-workbench','.cc-workbench-attachments','.CC-WORKBENCH-cache'])('rejects reserved component %s anywhere in its root or state path',component=>{
    expect(()=>createManagedWorkspaces({root:join(base,component,'tasks'),stateDir}).ensure(reservation())).toThrow('invalid_managed_workspace')
    expect(()=>createManagedWorkspaces({root,stateDir:join(base,component,'state')}).ensure(reservation())).toThrow('invalid_managed_workspace')
    expect(existsSync(root)).toBe(false)
  })

  it('rejects links in a root ancestor, at the root, at the leaf and in stateDir',()=>{
    const outside=join(base,'outside');mkdirSync(outside)
    const alias=join(base,'alias');link(outside,alias)
    for(const unsafeRoot of [alias,join(alias,'Tasks')])expect(()=>createManagedWorkspaces({root:unsafeRoot,stateDir}).ensure(reservation())).toThrow('managed_workspace_unavailable')
    expect(()=>createManagedWorkspaces({root,stateDir:alias}).ensure(reservation())).toThrow('managed_workspace_unavailable')
    mkdirSync(root,{recursive:true});const request=reservation();link(outside,join(root,request.workspaceId))
    expect(()=>createManagedWorkspaces({root,stateDir}).ensure(request)).toThrow('managed_workspace_unavailable')
    expect(existsSync(join(outside,'Tasks'))).toBe(false)
  })

  it('does not follow a link introduced after allocation during verify or cleanup',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation()),outside=join(base,'outside')
    mkdirSync(outside);writeFileSync(join(outside,'keep'),'safe');renameSync(workspace.path,workspace.path+'-saved');link(outside,workspace.path)
    expect(()=>manager.verify(workspace)).toThrow();expect(manager.removeEmptyCreated(workspace)).toBe(false)
    expect(readFileSync(join(outside,'keep'),'utf8')).toBe('safe');expect(lstatSync(workspace.path).isSymbolicLink()).toBe(true)
  })

  it('refuses a changed root even when the original workspace directory was moved into it',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation()),oldRoot=root+'-saved'
    renameSync(root,oldRoot);mkdirSync(root);renameSync(join(oldRoot,workspace.id),workspace.path)
    expect(()=>manager.verify(workspace)).toThrow('managed_workspace_changed')
    expect(manager.removeEmptyCreated(workspace)).toBe(false);expect(existsSync(workspace.path)).toBe(true)
  })
})

describe('rollback cleanup',()=>{
  it('removes only this allocation’s unchanged empty leaf and leaves its parents',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation())
    expect(manager.removeEmptyCreated(workspace)).toBe(true);expect(existsSync(workspace.path)).toBe(false);expect(existsSync(root)).toBe(true)
    expect(manager.removeEmptyCreated(workspace)).toBe(false)
  })

  it('preserves newly appeared content instead of recursively removing a workspace',()=>{
    const manager=createManagedWorkspaces({root,stateDir}),workspace=manager.ensure(reservation())
    mkdirSync(join(workspace.path,'nested'));writeFileSync(join(workspace.path,'nested','keep'),'safe')
    expect(manager.removeEmptyCreated(workspace)).toBe(false);expect(readFileSync(join(workspace.path,'nested','keep'),'utf8')).toBe('safe')
  })

  it('cannot clean up an allocation created by a prior manager instance',()=>{
    const workspace=createManagedWorkspaces({root,stateDir}).ensure(reservation())
    expect(createManagedWorkspaces({root,stateDir}).removeEmptyCreated(workspace)).toBe(false);expect(existsSync(workspace.path)).toBe(true)
  })
})
