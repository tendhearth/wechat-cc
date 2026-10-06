import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync,spawn} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openSqlite,type SqlDatabase} from '../../lib/runtime/sqlite'
import {createGitWorkspaces,type GitWorkspacePrepareInput} from './git-workspaces'
import {GIT_WORKSPACE_SCHEMA_SQL} from './git-workspace-store'

let base:string,source:string,root:string,stateDir:string,db:SqlDatabase
function git(path:string,...args:string[]):string {
  const env={...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}
  for(const key of Object.keys(env))if(key.startsWith('GIT_')&&!['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'].includes(key))delete (env as Record<string,string|undefined>)[key]
  return execFileSync('git',['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','core.fsmonitor=false','-C',path,...args],{env,encoding:'utf8'})
}
function input(sourcePath=source,workspaceId=randomUUID()):GitWorkspacePrepareInput{return {workspaceId,ownerKey:'fixture-owner',requestId:randomUUID(),canonicalRequestHash:'a'.repeat(64),sourcePath,providerId:'fixture'}}
const manager=()=>createGitWorkspaces({db,root,stateDir})
beforeEach(()=>{
  base=realpathSync(mkdtempSync(join(tmpdir(),'cc-git-workspaces-')));source=join(base,'project');root=join(base,'Tasks','GitWorkspaces');stateDir=join(base,'state')
  mkdirSync(source);mkdirSync(stateDir)
  git(source,'init','-b','main');writeFileSync(join(source,'a.txt'),'base\r\n');writeFileSync(join(source,'gone.txt'),'delete me');mkdirSync(join(source,'sub'));writeFileSync(join(source,'sub','nested.txt'),'nested');writeFileSync(join(source,'.gitignore'),'ignored*\n')
  git(source,'add','.');git(source,'commit','-m','base');db=openSqlite(join(stateDir,'test.sqlite'));db.exec(GIT_WORKSPACE_SCHEMA_SQL)
})
afterEach(()=>{db.close();rmSync(base,{recursive:true,force:true})})

describe('isolated Git workspaces',()=>{
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
  it('rejects an unpinned record object instead of trusting caller supplied identities',async()=>{
    const m=manager(),a=await m.prepare(input())
    await expect(m.verify({...a,executionPath:source})).rejects.toThrow('git_workspace_conflict')
  })
})
