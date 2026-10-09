import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {execFileSync,spawnSync} from 'node:child_process'
import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

let root:string
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-restore-fifo-')))})
afterEach(()=>rmSync(root,{recursive:true,force:true}))

// A separate process is essential: a blocking open freezes the test runner's
// event loop, so its ordinary test timeout cannot stop this regression.
describe.skipIf(process.platform==='win32')('restore snapshot special-file reads',()=>{
  it.each([
    ['loadBlob','blob_invalid'],
    ['saveBlob','blob_invalid'],
    ['readVersion','file_changed'],
    ['observe','file_identity_changed'],
    ['verifyDirectoryAfterWrite','directory_identity_changed'],
  ])('rejects FIFO in %s before blocking or reading', (operation,reason)=>{
    execFileSync('mkfifo',[join(root,'fifo')])
    const modulePath=fileURLToPath(new URL('./restore-snapshots.ts',import.meta.url))
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';
      import {join} from 'node:path';
      const root=${JSON.stringify(root)}, operation=${JSON.stringify(operation)};
      const snapshots=await import(${JSON.stringify(modulePath)});
      const bytes=Buffer.from('original'),sha=snapshots.digest(bytes);
      const fifo=join(root,'fifo'),file=join(root,'file.txt');
      let call;
      if(operation==='loadBlob'||operation==='saveBlob') {
        fs.renameSync(fifo,join(root,sha));
        const identity=snapshots.directoryId(root);
        call=()=>operation==='loadBlob'?snapshots.loadBlob(root,sha,identity):snapshots.saveBlob(root,bytes,identity);
      } else if(operation==='verifyDirectoryAfterWrite') {
        call=()=>snapshots.verifyDirectoryAfterWrite(fifo);
      } else {
        fs.writeFileSync(file,bytes);
        const version=snapshots.observe(root,'file.txt');
        if(operation==='readVersion') {
          fs.unlinkSync(file);fs.renameSync(fifo,file);
          call=()=>snapshots.readVersion(root,'file.txt',version);
        } else {
          // The optional directory-name cache is read between lstat and open.
          // Replace the real leaf at that boundary, without mocking filesystem I/O.
          const cache=new Map([[root,new Set(['file.txt'])]]);
          cache.get=()=>{fs.unlinkSync(file);fs.renameSync(fifo,file);return new Set(['file.txt'])};
          call=()=>snapshots.observe(root,'file.txt',undefined,cache);
        }
      }
      try {call();console.log('accepted')} catch(error) {console.log(error.message)}
    `],{cwd:root,encoding:'utf8',timeout:1500,killSignal:'SIGKILL'})
    expect(child.error?.message).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status,child.stderr).toBe(0)
    expect(child.stdout.trim()).toBe(reason)
  })
})
