import {afterEach,beforeEach,expect,it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {captureGitBaseline,finishGitReview} from './git-review'
import {removeTempDir} from '../../lib/test-temp'
let root:string
function git(...args:string[]){return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
function file(name:string,text:string|Buffer){writeFileSync(join(root,name),text)}
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'cc-review-'));git('init','-q');git('config','user.email','test@localhost');git('config','user.name','Test');file('app.ts','const answer = 1\n');git('add','.');git('commit','-qm','base')})
afterEach(()=>removeTempDir(root))
it('compares actual baseline including pre-existing staged edits without changing index or HEAD',async()=>{
 file('app.ts','const answer = 2\n');git('add','app.ts');file('notes.md','already here\n')
 const baseline=await captureGitBaseline(root)
 file('app.ts','const answer = 3\n')
 const head=git('rev-parse','HEAD'),status=git('status','--porcelain'),index=readFileSync(join(root,'.git/index'))
 const report=(await finishGitReview(baseline))!
 expect(report.status).toBe('complete');expect(report.preexistingPaths).toContain('app.ts');expect(report.preexistingPaths).toContain('notes.md')
 const change=report.files.find(f=>f.path==='app.ts')!
 expect(change.preexisting).toBe(true);expect(change.diff).toContain('-const answer = 2');expect(change.diff).toContain('+const answer = 3');expect(change.diff).not.toContain('-const answer = 1')
 expect(report.files.some(f=>f.path==='notes.md')).toBe(false)
 expect(git('rev-parse','HEAD')).toBe(head);expect(readFileSync(join(root,'.git/index'))).toEqual(index);expect(git('status','--porcelain')).toBe(status)
})
it('includes changes committed during the run, new files and deleted files',async()=>{
 const baseline=await captureGitBaseline(root);file('app.ts','const answer = 9\n');git('add','app.ts');git('commit','-qm','agent commit');file('new.py','print(1)\n')
 const report=(await finishGitReview(baseline))!
 expect(report.files.find(f=>f.path==='app.ts')?.diff).toContain('+const answer = 9')
 expect(report.files.find(f=>f.path==='new.py')?.kind).toBe('added')
 const second=await captureGitBaseline(root);rmSync(join(root,'app.ts'));rmSync(join(root,'new.py'))
 expect((await finishGitReview(second))?.files.map(f=>f.kind)).toEqual(['deleted','deleted'])
})
it('limits nested projects and excludes task outputs from code review',async()=>{
 mkdirSync(join(root,'nested'));file('nested/local.ts','one\n');git('add','.');git('commit','-qm','nested')
 const baseline=await captureGitBaseline(join(root,'nested'));file('app.ts','outside\n');file('nested/local.ts','two\n');mkdirSync(join(root,'nested/.cc-workbench'));file('nested/.cc-workbench/report.md','output\n')
 const report=(await finishGitReview(baseline))!
 expect(report.files.map(f=>f.path)).toEqual(['local.ts']);expect(report.files[0]?.diff).toContain('-one')
})
it('reports binary, symlink and oversized files honestly without reading their targets',async()=>{
 const baseline=await captureGitBaseline(root,{maxFileBytes:64});file('picture.png',Buffer.from([0,1,2,3]));file('huge.ts','x'.repeat(65));symlinkSync('/etc/passwd',join(root,'link.ts'))
 const report=(await finishGitReview(baseline))!
 expect(report.status).toBe('partial');expect(report.files.map(f=>f.path)).toEqual(['huge.ts','link.ts','picture.png'])
 expect(report.files.every(f=>f.kind==='not_reviewed' && !f.diff)).toBe(true)
 expect(JSON.stringify(report)).not.toContain('root:')
})
it('does not turn a non-git folder into a repository and supports unborn git projects',async()=>{
 const plain=join(root,'plain');mkdirSync(plain)
 // An inherited parent repo is still a repository; place a genuinely separate directory outside it.
 const separate=mkdtempSync(join(tmpdir(),'cc-plain-'))
 try{expect(await finishGitReview(await captureGitBaseline(separate))).toBeNull()}finally{removeTempDir(separate)}
 const unborn=join(root,'unborn');mkdirSync(unborn);execFileSync('git',['init','-q'],{cwd:unborn});writeFileSync(join(unborn,'draft.md'),'before\n')
 const baseline=await captureGitBaseline(unborn);writeFileSync(join(unborn,'draft.md'),'after\n')
 expect((await finishGitReview(baseline))?.files[0]?.diff).toContain('-before')
})
it('marks a bounded capture partial instead of inventing an unchanged project',async()=>{
 const baseline=await captureGitBaseline(root,{maxPaths:1});file('a.ts','a\n');file('b.ts','b\n')
 const report=(await finishGitReview(baseline))!
 expect(report.status).toBe('partial');expect(report.notes.length).toBeGreaterThan(0)
})
it('never executes repository filters, fsmonitor or inherited Git command configuration',async()=>{
 const marker=join(root,'executed.txt')
 const command=`printf unsafe >> '${marker}'; cat`
 file('.gitattributes','*.ts filter=hostile\n')
 git('config','filter.hostile.clean',command);git('config','filter.hostile.smudge',command)
 git('config','filter.hostile.required','true');git('config','core.fsmonitor',command)
 const baseline=await captureGitBaseline(root);file('app.ts','const answer = 4\n')
 git('config','filter.new.clean',command);file('.gitattributes','*.ts filter=new\n')
 const saved=process.env.GIT_CONFIG_COUNT
 process.env.GIT_CONFIG_COUNT='1';process.env.GIT_CONFIG_KEY_0='core.fsmonitor';process.env.GIT_CONFIG_VALUE_0=command
 try{
  const report=(await finishGitReview(baseline))!
  expect(report.status).toBe('complete');expect(report.files.find(f=>f.path==='app.ts')?.diff).toContain('+const answer = 4')
  expect(()=>readFileSync(marker)).toThrow()
 }finally{if(saved===undefined)delete process.env.GIT_CONFIG_COUNT;else process.env.GIT_CONFIG_COUNT=saved;delete process.env.GIT_CONFIG_KEY_0;delete process.env.GIT_CONFIG_VALUE_0}
})
it('does not exceed total text limits or include workbench handoff inputs',async()=>{
 git('rm','app.ts');git('commit','-qm','empty')
 const baseline=await captureGitBaseline(root,{maxTotalBytes:20})
 file('one.ts','a'.repeat(15));file('two.ts','b'.repeat(15))
 mkdirSync(join(root,'.cc-workbench-inputs'));file('.cc-workbench-inputs/packet.md','private context')
 const report=(await finishGitReview(baseline))!
 expect(report.status).toBe('partial');expect(report.files.filter(f=>f.diff)).toHaveLength(1)
 expect(report.files.some(f=>f.path.includes('.cc-workbench-inputs'))).toBe(false)
})
it('captures actual CRLF bytes and does not trust assume-unchanged flags',async()=>{
 file('.gitattributes','*.ts text eol=crlf\n');git('add','.gitattributes');git('commit','-qm','attributes')
 file('app.ts','const answer = 1\r\n');git('update-index','--assume-unchanged','app.ts')
 const before=readFileSync(join(root,'app.ts'));const baseline=await captureGitBaseline(root)
 file('app.ts','const answer = 8\r\n')
 const report=(await finishGitReview(baseline))!
 expect(report.files.find(f=>f.path==='app.ts')?.beforeSha256).toBe((await import('node:crypto')).createHash('sha256').update(before).digest('hex'))
 expect(report.files.find(f=>f.path==='app.ts')?.diff).toContain('+const answer = 8')
})
it('keeps an ignored working file staged for deletion in the baseline roster',async()=>{
 git('rm','--cached','app.ts');file('.gitignore','app.ts\n')
 const baseline=await captureGitBaseline(root);file('app.ts','changed after staged deletion\n')
 expect((await finishGitReview(baseline))?.files.find(f=>f.path==='app.ts')?.diff).toContain('-const answer = 1')
})
it('preserves BOM bytes and reports unreadable Git repositories as unavailable',async()=>{
 const baseline=await captureGitBaseline(root);file('app.ts','\ufeffconst answer = 1\n')
 expect((await finishGitReview(baseline))?.files.find(f=>f.path==='app.ts')?.diff).toContain('\ufeff')
 file('.git/config','[broken\n')
 expect((await finishGitReview(await captureGitBaseline(root)))?.status).toBe('unavailable')
})
it('does not publish common secret filenames or read binary files past the byte cap',async()=>{
 git('rm','app.ts');git('commit','-qm','empty')
 const baseline=await captureGitBaseline(root,{maxTotalBytes:20})
 file('a.bin',Buffer.alloc(15));file('b.bin',Buffer.alloc(15));file('id_rsa','private contents');file('credentials.json','secret contents')
 const report=(await finishGitReview(baseline))!
 expect(report.files.find(f=>f.path==='b.bin')?.reason).toBe('内容总量超过限制')
 expect(JSON.stringify(report)).not.toContain('private contents');expect(JSON.stringify(report)).not.toContain('secret contents')
})

it('never expands credential-named files even within the normal size budget',async()=>{
 const baseline=await captureGitBaseline(root)
 file('id_ed25519','private contents');file('credentials.json','secret contents');file('private-key.pem','private contents')
 const report=(await finishGitReview(baseline))!
 expect(report.files).toHaveLength(3);expect(report.files.every(f=>f.kind==='not_reviewed'&&!f.diff)).toBe(true)
 expect(JSON.stringify(report)).not.toContain('private contents');expect(JSON.stringify(report)).not.toContain('secret contents')
})
it('bounds serialized JSON even when control characters expand sixfold',async()=>{
 const {serializeGitReview}=await import('./git-review')
 const baseline=await captureGitBaseline(root)
 const report=(await finishGitReview(baseline))!
 report.files=[{path:'file.ts',kind:'modified',preexisting:false,diff:'\u0001'.repeat(3000)}]
 const bytes=serializeGitReview(report,2048)
 expect(bytes.length).toBeLessThanOrEqual(2048)
 expect(JSON.parse(bytes.toString())).toMatchObject({status:'partial',files:[{kind:'not_reviewed'}]})
})
