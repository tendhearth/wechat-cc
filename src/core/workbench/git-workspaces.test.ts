import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync,spawn} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,chmodSync,unlinkSync,symlinkSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openSqlite,type SqlDatabase} from '../../lib/runtime/sqlite'
import {createGitWorkspaces,type GitWorkspacePrepareInput} from './git-workspaces'
import {createGitWorkspaceStore,GIT_WORKSPACE_SCHEMA_SQL} from './git-workspace-store'
import * as gitRunner from './git-runner'

let base:string,source:string,root:string,stateDir:string,db:SqlDatabase
function git(path:string,...args:string[]):string {
  const env={...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}
  for(const key of Object.keys(env))if(key.startsWith('GIT_')&&!['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'].includes(key))delete (env as Record<string,string|undefined>)[key]
  return execFileSync('git',['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','core.fsmonitor=false','-C',path,...args],{env,encoding:'utf8'})
}
function input(sourcePath=source,workspaceId=randomUUID()):GitWorkspacePrepareInput{return {workspaceId,ownerKey:'fixture-owner',requestId:randomUUID(),canonicalRequestHash:'a'.repeat(64),sourcePath,providerId:'fixture'}}
const manager=()=>createGitWorkspaces({db,root,stateDir})
// Keep real Git effects/state and alter only its absolute-directory output. This
// models a spelling boundary without pretending POSIX can execute Windows paths.
function gitDirectoryOutput(transform:(path:string,kind:'rev-parse'|'registration')=>string) {
  const create=gitRunner.createGitRunner
  vi.spyOn(gitRunner,'createGitRunner').mockImplementation(options=>{
    const runner=create(options)
    return {async run(cwd,args,runOptions){
      const bytes=await runner.run(cwd,args,runOptions)
      if(args[0]==='rev-parse'&&['--show-toplevel','--absolute-git-dir','--git-common-dir'].some(option=>args.includes(option)))return Buffer.from(transform(bytes.toString('utf8').trim(),'rev-parse')+'\n')
      if(args[0]==='worktree'&&args[1]==='list')return Buffer.from(bytes.toString('utf8').split('\0').map(entry=>entry.startsWith('worktree ')?'worktree '+transform(entry.slice(9),'registration'):entry).join('\0'))
      return bytes
    }}
  })
}
beforeEach(()=>{
  base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-workspaces-')));source=join(base,'project');root=join(base,'Tasks','GitWorkspaces');stateDir=join(base,'state')
  mkdirSync(source);mkdirSync(stateDir)
  git(source,'init','-b','main');writeFileSync(join(source,'a.txt'),'base\r\n');writeFileSync(join(source,'gone.txt'),'delete me');mkdirSync(join(source,'sub'));writeFileSync(join(source,'sub','nested.txt'),'nested');writeFileSync(join(source,'.gitignore'),'ignored*\n')
  git(source,'add','.');git(source,'commit','-m','base');db=openSqlite(join(stateDir,'test.sqlite'));db.exec(GIT_WORKSPACE_SCHEMA_SQL)
})
afterEach(()=>{vi.restoreAllMocks();db.close();rmSync(base,{recursive:true,force:true})})

describe('isolated Git workspaces',()=>{
  it('reuses the first frozen reservation for concurrent same-UUID managers with separate SQLite connections',async()=>{
    const secondDb=openSqlite(join(stateDir,'test.sqlite')),request=input();let firstCreatedAt:number|undefined,clock=Date.now()
    // Distinct admission attempts may reach reservation in the same millisecond;
    // make their new timestamps distinct without changing Git or SQLite effects.
    vi.spyOn(Date,'now').mockImplementation(()=>++clock)
    const validate=async()=>{firstCreatedAt??=m1.get(request.workspaceId)!.createdAt;return 'fixture-config'}
    const m1=createGitWorkspaces({db,root,stateDir,validateConfiguration:validate}),m2=createGitWorkspaces({db:secondDb,root,stateDir,validateConfiguration:validate})
    try{
      const sourceBefore=await m1.readGitState(source)
      const [first,second]=await Promise.allSettled([m1.prepare(request),m2.prepare(request)])
      expect([first.status,second.status]).toEqual(['fulfilled','fulfilled'])
      if(first.status!=='fulfilled'||second.status!=='fulfilled')throw Error('concurrent_preparation_rejected')
      const a=first.value,b=second.value
      expect({...a,updatedAt:0}).toEqual({...b,updatedAt:0});expect(a.status).toBe('ready');expect(a.createdAt).toBe(firstCreatedAt)
      expect(m1.get(a.id)?.createdAt).toBe(firstCreatedAt);expect(m2.get(a.id)?.createdAt).toBe(firstCreatedAt)
      expect(readdirSync(root)).toEqual([request.workspaceId])
      expect(git(source,'branch','--list','--format=%(refname:short)','codex/cc-task-*').trim().split('\n')).toEqual([a.branch])
      expect(git(source,'worktree','list','--porcelain').split('worktree ').length).toBe(3)
      expect(readFileSync(join(source,'a.txt'),'utf8')).toBe('base\r\n');expect(git(source,'branch','--show-current').trim()).toBe('main')
      expect(await m1.readGitState(source)).toEqual(sourceBefore)
    }finally{secondDb.close()}
  })
  it('keeps semantic reservation fields and the first creation time immutable',async()=>{
    const a=await manager().prepare(input()),store=createGitWorkspaceStore(db)
    expect(store.reserve({...a,createdAt:a.createdAt+1})).toEqual(a)
    for(const changed of [{ownerKey:'other'},{sourceIdentity:a.sourceIdentity+'-other'},{baseCommit:'b'.repeat(40)},{sourceGitState:{...a.sourceGitState,head:'b'.repeat(40)}},{sourceGitState:{...a.sourceGitState,index:{...a.sourceGitState.index,'a.txt':'100644 '+'b'.repeat(40)+' 0'}}},{sourceStatus:'dirty'}]){
      expect(()=>store.reserve({...a,...changed,createdAt:a.createdAt+1})).toThrow('git_workspace_conflict')
      expect(store.get(a.id)).toEqual(a)
    }
    expect(()=>store.update({...a,createdAt:a.createdAt+1})).toThrow('git_workspace_conflict')
    expect(store.get(a.id)).toEqual(a)
  })
  it.each(['rev-parse','registration'] as const)('verifies and retries when Git %s paths use an equivalent separator spelling',async kind=>{
    gitDirectoryOutput((path,outputKind)=>outputKind===kind?path.replaceAll('\\','/')+'/':path)
    const request=input(),m=manager(),a=await m.prepare(request)
    expect(a.status).toBe('ready');expect(a.gitRoot).toBe(source);expect(a.worktreeRoot).toBe(join(root,request.workspaceId))
    writeFileSync(join(a.executionPath,'a.txt'),'task edit')
    await m.verify(a);expect(await manager().prepare(request)).toEqual(a)
    expect((await m.exportPatch(a)).bytes.toString()).toContain('+task edit')
    expect(readFileSync(join(source,'a.txt'),'utf8')).toBe('base\r\n')
  })
  it.each(['different-directory','dot-segment','symlink'] as const)('rejects a Git root reported through %s before allocation',async kind=>{
    const alias=join(base,'alias')
    if(kind==='symlink')symlinkSync(source,alias,process.platform==='win32'?'junction':'dir')
    const reported=kind==='different-directory'?stateDir:kind==='dot-segment'?source+'/../project':alias
    gitDirectoryOutput((path,outputKind)=>outputKind==='rev-parse'&&path.replaceAll('\\','/')===source.replaceAll('\\','/')?reported:path)
    await expect(manager().prepare(input())).rejects.toThrow('git_workspace_source_unsupported')
    expect(existsSync(root)).toBe(false);expect(readFileSync(join(source,'a.txt'),'utf8')).toBe('base\r\n')
  })
  it('rejects a registration redirected to a directory alias while preserving task contents',async()=>{
    const m=manager(),a=await m.prepare(input()),alias=join(base,'task-alias')
    symlinkSync(a.worktreeRoot,alias,process.platform==='win32'?'junction':'dir')
    gitDirectoryOutput((path,kind)=>kind==='registration'&&path.replaceAll('\\','/')===a.worktreeRoot.replaceAll('\\','/')?alias:path)
    writeFileSync(join(a.executionPath,'a.txt'),'keep')
    await expect(manager().verify(a)).rejects.toThrow('git_workspace_changed')
    expect(readFileSync(join(a.executionPath,'a.txt'),'utf8')).toBe('keep')
  })
  it('recovers a pinned provisioning worktree when Git registration uses an equivalent separator spelling',async()=>{
    gitDirectoryOutput((path,kind)=>kind==='registration'?path.replaceAll('\\','/')+'/':path)
    const request=input();db.exec("CREATE TRIGGER interrupt_ready BEFORE UPDATE ON workbench_git_workspaces WHEN NEW.status='ready' BEGIN SELECT RAISE(FAIL,'receipt_interrupted'); END")
    await expect(manager().prepare(request)).rejects.toThrow('receipt_interrupted')
    db.exec('DROP TRIGGER interrupt_ready')
    const a=await manager().prepare(request)
    expect(a.status).toBe('ready');expect(a.worktreeRoot).toBe(join(root,request.workspaceId))
    expect(git(source,'worktree','list','--porcelain').split('worktree ').length).toBe(3)
  })
  it('ignores an unrelated stale Git registration without adopting or deleting it',async()=>{
    const stale=join(base,'stale');git(source,'worktree','add','-b','unrelated',stale,'HEAD');rmSync(stale,{recursive:true})
    const m=manager(),a=await m.prepare(input());await m.verify(a)
    expect(git(source,'worktree','list','--porcelain')).toContain(stale.replaceAll('\\','/'))
    expect(git(source,'branch','--list','--format=%(refname:short)','unrelated').trim()).toBe('unrelated')
  })
  it('isolates two task directories and preserves the source branch, index and files; restart retry retains edits',async()=>{
    const m=manager(),request=input(),before=await m.readGitState(source)
    const [a,b]=await Promise.all([m.prepare(request),m.prepare(input())])
    expect(a.executionPath).not.toBe(b.executionPath);expect(a.branch).not.toBe(b.branch)
    writeFileSync(join(a.executionPath,'a.txt'),'task change')
    expect(readFileSync(join(source,'a.txt'),'utf8')).toBe('base\r\n');expect(git(source,'branch','--show-current').trim()).toBe('main');expect(await m.readGitState(source)).toEqual(before)
    expect(await manager().prepare(request)).toEqual(a);expect(readFileSync(join(a.executionPath,'a.txt'),'utf8')).toBe('task change')
    await m.verify(a)
  })
  it('maps a project subdirectory and exports only that project scope',async()=>{
    const m=manager(),a=await m.prepare(input(join(source,'sub')))
    expect(a.projectSubpath).toBe('sub');expect(a.executionPath).toBe(join(a.worktreeRoot,'sub'))
    writeFileSync(join(a.worktreeRoot,'a.txt'),'outside');writeFileSync(join(a.executionPath,'nested.txt'),'inside')
    const patch=await m.exportPatch(a);expect(patch.bytes.toString()).toContain('sub/nested.txt');expect(patch.bytes.toString()).not.toContain('a.txt');expect(patch.excluded).toContain('outside_project')
  })
  it.each(['ownerKey','requestId','canonicalRequestHash','sourcePath','providerId'] as const)('rejects changed frozen %s on UUID retry',async field=>{
    const m=manager(),request=input();await m.prepare(request)
    await expect(m.prepare({...request,[field]:field==='canonicalRequestHash'?'b'.repeat(64):request[field]+'-changed'})).rejects.toThrow('git_workspace_conflict')
  })
  it('rejects reuse of an owner request with a different UUID',async()=>{
    const m=manager(),request=input();await m.prepare(request)
    await expect(m.prepare({...request,workspaceId:randomUUID()})).rejects.toThrow('git_workspace_conflict')
  })
  it.each(['unstaged','staged','untracked','no-head','submodule','rebase','merge','assume-unchanged','skip-worktree'])('rejects unsupported source %s before allocation',async kind=>{
    if(kind==='unstaged'||kind==='staged'){writeFileSync(join(source,'a.txt'),'dirty');if(kind==='staged')git(source,'add','a.txt')}
    if(kind==='assume-unchanged'||kind==='skip-worktree'){git(source,'update-index','--'+kind,'a.txt');writeFileSync(join(source,'a.txt'),'hidden dirty bytes')}
    if(kind==='untracked')writeFileSync(join(source,'new.txt'),'dirty')
    if(kind==='no-head'){source=join(base,'empty');mkdirSync(source);git(source,'init','-b','main')}
    if(kind==='submodule') {git(source,'update-index','--add','--cacheinfo','160000,'+git(source,'rev-parse','HEAD').trim()+',module');git(source,'commit','-m','gitlink')}
    if(kind==='rebase')mkdirSync(join(source,'.git','rebase-merge'))
    if(kind==='merge')writeFileSync(join(source,'.git','MERGE_HEAD'),git(source,'rev-parse','HEAD'))
    await expect(manager().prepare(input())).rejects.toThrow('git_workspace_source_unsupported');expect(existsSync(root)).toBe(false)
  })
  it('rejects existing task branches and strangers in the target directory without deleting either',async()=>{
    const request=input();git(source,'branch','codex/cc-task-'+request.workspaceId)
    await expect(manager().prepare(request)).rejects.toThrow('git_workspace_needs_recovery')
    const other=input();mkdirSync(join(root,other.workspaceId),{recursive:true});writeFileSync(join(root,other.workspaceId,'stranger'),'keep')
    await expect(manager().prepare(other)).rejects.toThrow('git_workspace_needs_recovery');expect(readFileSync(join(root,other.workspaceId,'stranger'),'utf8')).toBe('keep')
  })
  it('detects source and execution directory identity changes on verification',async()=>{
    const m=manager(),a=await m.prepare(input());renameSync(a.executionPath,a.executionPath+'-old');mkdirSync(a.executionPath)
    await expect(m.verify(a)).rejects.toThrow('git_workspace_changed')
    renameSync(source,source+'-old');mkdirSync(source);await expect(m.verify(a)).rejects.toThrow('git_workspace_changed')
  })
  it('configuration rejection never hands out a ready workspace and cannot be bypassed on retry',async()=>{
    const request=input(),m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async()=>{throw Error('configuration_not_reproducible')}})
    await expect(m.prepare(request)).rejects.toThrow('configuration_not_reproducible');expect(m.get(request.workspaceId)?.status).toBe('failed')
    await expect(m.prepare(request)).rejects.toThrow('configuration_not_reproducible')
  })
  it('rejects worktree changes that arrive during asynchronous configuration admission before ready',async()=>{
    const request=input(),m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async({executionPath})=>{writeFileSync(join(executionPath,'a.txt'),'changed while admitting');return 'config-v1'}})
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_needs_recovery');expect(m.get(request.workspaceId)?.status).toBe('needs_recovery')
  })
  it('recovers the same pinned registered worktree when ready receipt persistence fails',async()=>{
    const request=input();db.exec("CREATE TRIGGER interrupt_ready BEFORE UPDATE ON workbench_git_workspaces WHEN NEW.status='ready' BEGIN SELECT RAISE(FAIL,'receipt_interrupted'); END")
    await expect(manager().prepare(request)).rejects.toThrow('receipt_interrupted')
    db.exec('DROP TRIGGER interrupt_ready');const a=await manager().prepare(request)
    expect(a.status).toBe('ready');expect(git(source,'worktree','list','--porcelain').split('worktree ').length).toBe(3)
  })
  it.skipIf(process.platform==='win32')('does not execute hooks, fsmonitor or filter commands and ignores inherited GIT overrides',async()=>{
    const sentinel=join(base,'executed'),script=join(base,'danger.sh');writeFileSync(script,'#!/bin/sh\ntouch "'+sentinel+'"\ncat\n');chmodSync(script,0o755)
    writeFileSync(join(source,'.gitattributes'),'a.txt filter=danger\n');git(source,'add','.gitattributes');git(source,'commit','-m','attributes')
    git(source,'config','filter.danger.smudge',script);git(source,'config','filter.danger.clean',script);git(source,'config','filter.danger.process',script);git(source,'config','core.fsmonitor',script)
    const hooks=join(base,'hooks');mkdirSync(hooks);writeFileSync(join(hooks,'post-checkout'),'#!/bin/sh\ntouch "'+sentinel+'"\n');chmodSync(join(hooks,'post-checkout'),0o755);git(source,'config','core.hooksPath',hooks)
    const old=process.env.GIT_DIR;process.env.GIT_DIR=join(base,'nonexistent')
    try{const a=await manager().prepare(input());writeFileSync(join(a.executionPath,'a.txt'),'raw');await manager().exportPatch(a);expect(existsSync(sentinel)).toBe(false)}finally{if(old===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=old}
  })
  it.skipIf(process.platform==='win32')('never fetches a missing promisor blob or executes repository uploadpack while preparing',async()=>{
    const remote=join(base,'remote.git');git(base,'clone','--bare',source,remote);git(source,'remote','add','origin',remote)
    git(source,'config','remote.origin.promisor','true');git(source,'config','remote.origin.partialclonefilter','blob:none');git(remote,'config','uploadpack.allowFilter','true')
    const sentinel=join(base,'unexpected-fetch'),script=join(base,'upload-pack')
    writeFileSync(script,'#!/bin/sh\nprintf fetched > "'+sentinel+'"\nexec git-upload-pack "$@"\n');chmodSync(script,0o755);git(source,'config','remote.origin.uploadpack',script)
    const blob=git(source,'rev-parse','HEAD:a.txt').trim(),object=join(source,'.git','objects',blob.slice(0,2),blob.slice(2));unlinkSync(object)
    const request=input(),m=manager();let outcome=''
    try{outcome=(await m.prepare(request)).status}catch(error){outcome=(error as Error).message}
    expect({outcome,externalProgramExecuted:existsSync(sentinel)}).toEqual({outcome:'git_workspace_needs_recovery',externalProgramExecuted:false})
    expect(existsSync(object)).toBe(false);expect(m.get(request.workspaceId)?.status).toBe('needs_recovery')
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_needs_recovery')
  })
  it('exports committed, staged, unstaged, deleted, binary and untracked contents with a private index',async()=>{
    const m=manager(),a=await m.prepare(input());writeFileSync(join(a.executionPath,'a.txt'),'committed\r\n');git(a.executionPath,'add','a.txt');git(a.executionPath,'commit','-m','task commit')
    writeFileSync(join(a.executionPath,'staged.txt'),'stage');git(a.executionPath,'add','staged.txt');writeFileSync(join(a.executionPath,'a.txt'),'final\r\n');rmSync(join(a.executionPath,'gone.txt'));writeFileSync(join(a.executionPath,'new.bin'),Buffer.from([0,1,2,255]));writeFileSync(join(a.executionPath,'ignored-secret'),'secret')
    mkdirSync(join(a.executionPath,'.cc-workbench-inputs'));writeFileSync(join(a.executionPath,'.cc-workbench-inputs','secret'),'secret')
    const before=await m.readGitState(a.executionPath),sourceState=await m.readGitState(source),refs=git(source,'show-ref'),index=readFileSync(join(a.worktreeGitDir!,'index'))
    const patch=await m.exportPatch(a);expect(patch.sha256).toBe(createHash('sha256').update(patch.bytes).digest('hex'));expect(patch.bytes.toString()).not.toContain('secret');expect(patch.excluded).toEqual(expect.arrayContaining(['ignored','internal']))
    const target=join(base,'apply');git(source,'worktree','add','--detach',target,a.baseCommit);const patchFile=join(base,'export.patch');writeFileSync(patchFile,patch.bytes);git(target,'apply','--binary',patchFile)
    expect(readFileSync(join(target,'a.txt'),'utf8')).toBe('final\r\n');expect(readFileSync(join(target,'staged.txt'),'utf8')).toBe('stage');expect(readFileSync(join(target,'new.bin'))).toEqual(Buffer.from([0,1,2,255]));expect(existsSync(join(target,'gone.txt'))).toBe(false)
    expect(await m.readGitState(a.executionPath)).toEqual(before);expect(await m.readGitState(source)).toEqual(sourceState);expect(git(source,'show-ref')).toBe(refs);expect(readFileSync(join(a.worktreeGitDir!,'index'))).toEqual(index)
  })
  it.skipIf(process.platform==='win32')('rejects a tracked path replaced by a FIFO without blocking a daemon worker',async()=>{
    const m=manager(),a=await m.prepare(input());rmSync(join(a.executionPath,'a.txt'));execFileSync('mkfifo',[join(a.executionPath,'a.txt')])
    const script=`import {openSqlite} from ${JSON.stringify(join(process.cwd(),'src/lib/runtime/sqlite.ts'))}; import {createGitWorkspaces} from ${JSON.stringify(join(process.cwd(),'src/core/workbench/git-workspaces.ts'))}; const db=openSqlite(${JSON.stringify(join(stateDir,'test.sqlite'))}); const m=createGitWorkspaces({db,root:${JSON.stringify(root)},stateDir:${JSON.stringify(stateDir)}}); try{await m.exportPatch(m.get(${JSON.stringify(a.id)}));console.log('unexpected_success')}catch(error){console.log(error.message)}finally{db.close()}`
    const outcome=await new Promise<string>(done=>{
      const child=spawn('bun',['-e',script],{stdio:['ignore','pipe','ignore']});let output='';let timedOut=false
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},3000);child.stdout.on('data',chunk=>{output+=chunk})
      child.once('close',()=>{clearTimeout(timer);done(timedOut?'timeout':output.trim())});child.once('error',()=>{clearTimeout(timer);done('unavailable')})
    })
    expect(outcome).toBe('git_workspace_export_unsupported')
  })
  it('refuses oversized complete export instead of handing out a partial patch',async()=>{
    const m=manager(),a=await m.prepare(input());writeFileSync(join(a.executionPath,'huge.bin'),Buffer.alloc(16*1024*1024+1))
    await expect(m.exportPatch(a)).rejects.toThrow('git_workspace_export_limit')
  })
  it('reads project-relative stage/mode/object entries for subdirectory index state',async()=>{
    const m=manager(),a=await m.prepare(input(join(source,'sub'))),state=await m.readGitState(a.executionPath)
    expect(Object.keys(state.index)).toEqual(['nested.txt']);expect(state.index['nested.txt']).toMatch(/^100644 [a-f0-9]{40} 0$/)
    expect(state.index['sub/nested.txt']).toBeUndefined();expect(state.index['a.txt']).toBeUndefined()
  })
  it.skipIf(process.platform==='win32')('refuses export when dirty source bytes change during private-index diff, even if porcelain status stays identical',async()=>{
    const m=manager(),a=await m.prepare(input());writeFileSync(join(source,'a.txt'),'dirty before');writeFileSync(join(a.executionPath,'a.txt'),'task diff')
    const bin=join(base,'bin');mkdirSync(bin);const actualGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(),wrapper=join(bin,'git')
    writeFileSync(wrapper,'#!/bin/sh\ncase " $* " in *" diff "*) /bin/echo "dirty after" > "'+join(source,'a.txt')+'";; esac\nexec "'+actualGit+'" "$@"\n');chmodSync(wrapper,0o755)
    const old=process.env.PATH;process.env.PATH=bin+':'+old
    try{await expect(m.exportPatch(a)).rejects.toThrow('git_workspace_export_changed')}finally{process.env.PATH=old}
    expect(readFileSync(join(a.executionPath,'a.txt'),'utf8')).toBe('task diff')
  })
  it('persists needs_recovery when a common-dir allocation lock is left by an interrupted process',async()=>{
    const request=input(),lock=join(source,'.git','cc-workbench-allocation.lock')
    writeFileSync(lock,JSON.stringify({pid:99999999,workspaceId:request.workspaceId,ownerKey:request.ownerKey,requestId:request.requestId}))
    const m=manager();await expect(m.prepare(request)).rejects.toThrow('git_workspace_needs_recovery')
    expect(m.get(request.workspaceId)?.status).toBe('needs_recovery');expect(existsSync(lock)).toBe(true);expect(existsSync(join(root,request.workspaceId))).toBe(false)
  })
  it('revalidates a configuration fingerprint on ready retries',async()=>{
    const request=input();let fingerprint='configuration-v1'
    const m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async()=>fingerprint})
    const a=await m.prepare(request);expect(a.configurationFingerprint).toBe('configuration-v1');fingerprint='configuration-v2'
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_configuration_changed');expect(m.get(a.id)?.status).toBe('failed')
  })
  it('rejects a real directory replacement during configuration on a ready retry and persists recovery',async()=>{
    const request=input();let calls=0
    const m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async({executionPath})=>{
      if(++calls===2){renameSync(executionPath,executionPath+'-saved');mkdirSync(executionPath);writeFileSync(join(executionPath,'stranger'),'keep')}
      return 'configuration-v1'
    }})
    const a=await m.prepare(request)
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_needs_recovery')
    expect(m.get(a.id)?.status).toBe('needs_recovery');expect(readFileSync(join(a.executionPath,'stranger'),'utf8')).toBe('keep')
    await expect(manager().prepare(request)).rejects.toThrow('git_workspace_needs_recovery')
  })
  it('rechecks task branch ownership after configuration on a ready retry',async()=>{
    const request=input();let calls=0
    const m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async({executionPath})=>{
      if(++calls===2)git(executionPath,'checkout','--detach')
      return 'configuration-v1'
    }})
    const a=await m.prepare(request)
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_needs_recovery');expect(m.get(a.id)?.status).toBe('needs_recovery')
  })
  it('retains task commits and staged or unstaged edits on a configuration-validated ready retry',async()=>{
    const request=input(),m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async()=> 'configuration-v1'}),a=await m.prepare(request)
    writeFileSync(join(a.executionPath,'a.txt'),'task commit');git(a.executionPath,'add','a.txt');git(a.executionPath,'commit','-m','task commit')
    writeFileSync(join(a.executionPath,'staged.txt'),'staged');git(a.executionPath,'add','staged.txt');writeFileSync(join(a.executionPath,'a.txt'),'working edit')
    const before=await m.readGitState(a.executionPath);expect(before.head).not.toBe(a.baseCommit)
    const returned=await m.prepare(request);expect(returned.status).toBe('ready');await m.verify(returned)
    expect(await m.readGitState(a.executionPath)).toEqual(before);expect(readFileSync(join(a.executionPath,'a.txt'),'utf8')).toBe('working edit')
  })
  it('sanitizes callback error text before returning and persisting a configuration failure',async()=>{
    const request=input(),secret='credential=private-token-value',m=createGitWorkspaces({db,root,stateDir,validateConfiguration:async()=>{throw Error(secret)}})
    await expect(m.prepare(request)).rejects.toThrow('git_workspace_configuration_rejected')
    expect(m.get(request.workspaceId)?.failureReason).toBe('git_workspace_configuration_rejected')
    expect(JSON.stringify(m.get(request.workspaceId))).not.toContain(secret)
  })
  it('rejects an unpinned record object instead of trusting caller supplied identities',async()=>{
    const m=manager(),a=await m.prepare(input())
    await expect(m.verify({...a,executionPath:source})).rejects.toThrow('git_workspace_conflict')
  })
})
