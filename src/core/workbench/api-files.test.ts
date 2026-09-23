import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,symlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {prepareApiFileTool} from './api-files'
import {removeTempDir} from '../../lib/test-temp'

let root:string,project:string,outside:string
const task='deadbeef'
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-api-files-')))
  project=join(root,'project');outside=join(root,'outside')
  mkdirSync(project);mkdirSync(outside)
  writeFileSync(join(outside,'secret.txt'),'private outside material')
})
afterEach(()=>removeTempDir(root))
const prepare=(name:string,input:unknown)=>prepareApiFileTool(project,task,name,input)
const run=(name:string,input:unknown)=>prepare(name,input).execute()

describe('API project materials',()=>{
  it('normalizes an approved path and reads a nested UTF-8 file only on execution',()=>{
    mkdirSync(join(project,'docs'));writeFileSync(join(project,'docs','brief.md'),'你好\nbrief')
    const action=prepare('ReadFile',{path:'./docs//brief.md'})
    expect(action.description).toContain('docs/brief.md')
    expect(action.description).not.toContain(project)
    writeFileSync(join(project,'docs','brief.md'),'updated material')
    expect(action.execute()).toBe('updated material')
  })

  it.each(['../outside/secret.txt','docs/../secret.txt','/etc/passwd','C:\\secret.txt','docs\\secret.txt','a\0b','a\nb',''])('rejects path escape or ambiguous path %j',(path)=>{
    expect(()=>prepare('ReadFile',{path})).toThrow('invalid_api_file_path')
  })

  it.each(['.cc-workbench','.cc-workbench-inputs','.cc-workbench-materials','.CC-WORKBENCH'])('excludes internal task directory %s at every depth',(internal)=>{
    mkdirSync(join(project,'docs',internal,'cafebabe'),{recursive:true})
    writeFileSync(join(project,'docs',internal,'cafebabe','secret.txt'),'private task material')
    expect(()=>prepare('ReadFile',{path:`docs/${internal}/cafebabe/secret.txt`})).toThrow('invalid_api_file_path')
    expect(()=>prepare('ListFiles',{path:`docs/${internal}`})).toThrow('invalid_api_file_path')
    expect(run('ListFiles',{path:'docs'})).not.toContain(internal)
    expect(run('ListFiles',{path:'docs'})).not.toContain('private task material')
  })

  it.each(['ReadFile','ListFiles'])('does not follow project-root or ancestor symlinks for %s',(name)=>{
    const input={path:name==='ReadFile'?'secret.txt':'.'}
    symlinkSync(outside,join(root,'linked-project'))
    expect(()=>prepareApiFileTool(join(root,'linked-project'),task,name,input)).toThrow('invalid_api_file_path')
    mkdirSync(join(outside,'nested'))
    expect(()=>prepareApiFileTool(join(root,'linked-project','nested'),task,name,input)).toThrow('invalid_api_file_path')
  })

  it.each(['.cc-workbench','.cc-workbench-inputs','.cc-workbench-materials','.CC-WORKBENCH'])('rejects an internal project root or ancestor named %s for every tool',(internal)=>{
    const internalRoot=join(project,internal),nestedRoot=join(internalRoot,'cafebabe','nested')
    mkdirSync(nestedRoot,{recursive:true})
    for(const selectedRoot of [internalRoot,nestedRoot]){
      writeFileSync(join(selectedRoot,'report.md'),'private task report')
      for(const [name,input] of [
        ['ReadFile',{path:'report.md'}],
        ['ListFiles',{}],
        ['SaveArtifact',{name:'created.md',content:'unsafe write'}],
      ] as const){
        expect(()=>prepareApiFileTool(selectedRoot,task,name,input)).toThrow('invalid_api_file_path')
      }
      expect(existsSync(join(selectedRoot,'.cc-workbench'))).toBe(false)
    }
  })

  it('rejects read/list symlinks in both the parent and final component',()=>{
    symlinkSync(outside,join(project,'linked'))
    symlinkSync(join(outside,'secret.txt'),join(project,'leaf.txt'))
    for(const [name,path] of [['ReadFile','linked/secret.txt'],['ReadFile','leaf.txt'],['ListFiles','linked']]){
      expect(()=>run(name!,{path})).toThrow('invalid_api_file_path')
    }
  })

  it('rejects hard links that could alias private material outside the project',()=>{
    linkSync(join(outside,'secret.txt'),join(project,'linked-material.txt'))
    expect(()=>run('ReadFile',{path:'linked-material.txt'})).toThrow('invalid_api_file_path')
  })

  it('rejects a root replaced after approval even by a real directory',()=>{
    writeFileSync(join(project,'brief.md'),'original')
    const read=prepare('ReadFile',{path:'brief.md'}),list=prepare('ListFiles',{})
    renameSync(project,join(root,'moved-project'));mkdirSync(project)
    writeFileSync(join(project,'brief.md'),'replacement')
    expect(()=>read.execute()).toThrow('api_project_changed')
    expect(()=>list.execute()).toThrow('api_project_changed')
  })

  it('rechecks parent boundaries after approval',()=>{
    mkdirSync(join(project,'docs'));writeFileSync(join(project,'docs','secret.txt'),'original')
    const action=prepare('ReadFile',{path:'docs/secret.txt'})
    renameSync(join(project,'docs'),join(project,'original-docs'));symlinkSync(outside,join(project,'docs'))
    expect(()=>action.execute()).toThrow('invalid_api_file_path')
  })

  it.each([Buffer.from('text\0binary'),Buffer.from([0xff,0xfe]),Buffer.from([1,2,3])])('rejects non-text bytes %j',(bytes)=>{
    writeFileSync(join(project,'binary.dat'),bytes)
    expect(()=>run('ReadFile',{path:'binary.dat'})).toThrow('api_file_not_text')
  })

  it('bounds reads and rejects directories and special files without blocking',()=>{
    writeFileSync(join(project,'large.txt'),'x'.repeat(1024*1024+1))
    mkdirSync(join(project,'directory'))
    execFileSync('mkfifo',[join(project,'pipe.txt')])
    for(const path of ['large.txt','directory','pipe.txt'])expect(()=>run('ReadFile',{path})).toThrow('invalid_api_file_size')
  })

  it('lists only the selected directory, omitting links and hidden task directories',()=>{
    mkdirSync(join(project,'docs'));writeFileSync(join(project,'brief.md'),'brief')
    writeFileSync(join(project,'docs','nested.txt'),'nested')
    mkdirSync(join(project,'.cc-workbench'));symlinkSync(outside,join(project,'outside-link'))
    const result=JSON.parse(run('ListFiles',{}))
    expect(result.path).toBe('.')
    expect(result.entries).toEqual([{name:'brief.md',type:'file'},{name:'docs',type:'directory'}])
    expect(result.truncated).toBe(false)
  })

  it('caps directory enumeration and signals truncation',()=>{
    for(let i=0;i<220;i++)writeFileSync(join(project,`file-${i}.txt`),'x')
    const result=JSON.parse(run('ListFiles',{}))
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.length).toBeLessThanOrEqual(200)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64*1024)
  })

  it('bounds the final listing after escaping long directory entry names',()=>{
    for(let i=0;i<190;i++)writeFileSync(join(project,`file-${i}-${'"'.repeat(220)}.txt`),'x')
    const output=run('ListFiles',{}),result=JSON.parse(output)
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64*1024)
  })
})

describe('API task artifacts',()=>{
  it('prepares a digest-bound approval without creating folders and writes exclusively to the task',()=>{
    const input={name:'report.md',content:'hello'}
    const action=prepare('SaveArtifact',input)
    expect(action.description).toContain('.cc-workbench/deadbeef/report.md')
    expect(action.description).toContain('5 bytes')
    expect(action.description).toContain('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(action.description).not.toContain(project)
    expect(existsSync(join(project,'.cc-workbench'))).toBe(false)
    input.content='changed'
    expect(action.execute()).toContain('.cc-workbench/deadbeef/report.md')
    expect(readFileSync(join(project,'.cc-workbench',task,'report.md'),'utf8')).toBe('hello')
    expect(()=>action.execute()).toThrow('api_artifact_exists_or_invalid_path')
    expect(readFileSync(join(project,'.cc-workbench',task,'report.md'),'utf8')).toBe('hello')
  })

  it.each(['../file.md','other/file.md','other\\file.md','.','..','file\0.md','.cc-workbench','file.','file '])('rejects unsafe artifact name %j',(name)=>{
    expect(()=>prepare('SaveArtifact',{name,content:'report'})).toThrow('invalid_api_file_path')
    expect(existsSync(join(project,'.cc-workbench'))).toBe(false)
  })

  it.each(['../bad','cafebabe/other','DEADBEEF','task',''])('rejects unsafe or foreign-shaped task id %j',(id)=>{
    expect(()=>prepareApiFileTool(project,id,'SaveArtifact',{name:'report.md',content:'safe'})).toThrow('invalid_api_task_id')
  })

  it('enforces the UTF-8 byte cap and rejects NUL content before effects',()=>{
    expect(()=>prepare('SaveArtifact',{name:'large.txt',content:'字'.repeat(350000)})).toThrow('invalid_api_file_size')
    expect(()=>prepare('SaveArtifact',{name:'binary.txt',content:'hello\0'})).toThrow('api_file_not_text')
    expect(existsSync(join(project,'.cc-workbench'))).toBe(false)
    run('SaveArtifact',{name:'limit.txt',content:'x'.repeat(1024*1024)})
    expect(readFileSync(join(project,'.cc-workbench',task,'limit.txt')).length).toBe(1024*1024)
  })

  it.each(['base','task','file'])('never follows a symlink at the artifact %s',(position)=>{
    const base=join(project,'.cc-workbench'),folder=join(base,task)
    if(position==='base')symlinkSync(outside,base)
    else{
      mkdirSync(base)
      if(position==='task')symlinkSync(outside,folder)
      else{mkdirSync(folder);symlinkSync(join(outside,'secret.txt'),join(folder,'report.md'))}
    }
    expect(()=>run('SaveArtifact',{name:'report.md',content:'unsafe'})).toThrow(position==='file'?'api_artifact_exists_or_invalid_path':'invalid_api_file_path')
    expect(readFileSync(join(outside,'secret.txt'),'utf8')).toBe('private outside material')
    expect(existsSync(join(outside,'report.md'))).toBe(false)
    expect(existsSync(join(outside,task))).toBe(false)
  })

  it('rejects root replacement before an approved save without writing into it',()=>{
    const action=prepare('SaveArtifact',{name:'report.md',content:'report'})
    renameSync(project,join(root,'moved-project'));mkdirSync(project)
    expect(()=>action.execute()).toThrow('api_project_changed')
    expect(existsSync(join(project,'.cc-workbench'))).toBe(false)
  })

  it('never overwrites an existing FIFO or directory',()=>{
    const folder=join(project,'.cc-workbench',task);mkdirSync(folder,{recursive:true})
    mkdirSync(join(folder,'directory'));execFileSync('mkfifo',[join(folder,'pipe')])
    for(const name of ['directory','pipe'])expect(()=>run('SaveArtifact',{name,content:'report'})).toThrow('api_artifact_exists_or_invalid_path')
  })
})

it('rejects unsupported tools and malformed argument shapes before effects',()=>{
  expect(()=>prepare('Shell',{command:'echo unsafe'})).toThrow('unsupported_api_tool')
  for(const [name,input] of [['ReadFile',null],['ReadFile',[]],['ReadFile',{path:'brief.md',extra:true}],['ListFiles',{path:3}],['SaveArtifact',{name:'report.md',content:12}]]){
    expect(()=>prepare(name as string,input)).toThrow()
  }
  expect(existsSync(join(project,'.cc-workbench'))).toBe(false)
})
