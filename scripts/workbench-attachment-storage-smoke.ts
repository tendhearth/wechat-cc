/** Compile an isolated fixture exactly like the desktop sidecar, then verify owned attachment IO. */
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'

const repository=resolve(import.meta.dir,'..'),directory=mkdtempSync(join(tmpdir(),'cc-storage-smoke-'))
try{
  const entry=join(directory,'fixture.ts'),executable=join(directory,'fixture')
  writeFileSync(entry,`
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDb} from ${JSON.stringify(join(repository,'src/lib/db'))}
import {makeWorkbenchStore} from ${JSON.stringify(join(repository,'src/core/workbench/store'))}
const root=realpathSync(mkdtempSync(join(tmpdir(),'attachment-compiled-'))),project=join(root,'project');mkdirSync(project)
const db=openDb({path:join(root,'state.db')}),store=makeWorkbenchStore(db)
try{
  const task=store.create({title:'fixture',path:project,providerId:'claude',ownerChatId:null}),draftId=randomUUID()
  const bytes=Buffer.from('compiled payload'),a=store.attachments.upload({id:randomUUID(),draftId,taskId:task.id,name:'notes.txt',mime:'text/plain',base64:bytes.toString('base64')},root)
  store.attachments.bind([a.id],task.id,draftId)
  const native=store.attachments.prepare(task.id,[a],project,root)[0]!
  if(!readFileSync(native.path).equals(bytes)||(statSync(native.path).mode&0o777)!==0o600)throw Error('payload_or_permissions_mismatch')
  if(store.attachments.read(task.id,a.id,root).base64!==bytes.toString('base64'))throw Error('snapshot_mismatch')
  console.log(JSON.stringify({compiled:true,upload:true,prepare:true,mode:'0600',sha256:a.sha256}))
}finally{db.close();rmSync(root,{recursive:true,force:true})}
`,{mode:0o600})
  for(const [command,args] of [[process.execPath,['build','--compile',entry,'--outfile',executable]],[executable,[]]] as const){
    const result=spawnSync(command,args,{cwd:repository,encoding:'utf8',timeout:60_000})
    if(result.stdout)process.stdout.write(result.stdout)
    if(result.stderr)process.stderr.write(result.stderr)
    if(result.error||result.status!==0)throw result.error??Error(`attachment_storage_smoke_failed:${result.status}`)
  }
}finally{rmSync(directory,{recursive:true,force:true})}
