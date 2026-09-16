import {afterEach,describe,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {basename,join} from 'node:path'
import {tmpdir} from 'node:os'
import {makeProjectCatalog} from './project-catalog'
import {removeTempDir} from '../../lib/test-temp'

const roots:string[]=[]
const root=()=>{const path=mkdtempSync(join(tmpdir(),'cc-project-catalog-'));roots.push(path);return path}
afterEach(()=>{for(const path of roots.splice(0))removeTempDir(path)})

describe('project catalog',()=>{
  it('canonicalizes and deduplicates symlinks while keeping the registered alias',()=>{
    const area=root(),project=join(area,'project'),aliasPath=join(area,'alias')
    mkdirSync(project);symlinkSync(project,aliasPath)
    const rows=makeProjectCatalog({ownerChatId:'owner',registered:[{alias:'My Project',path:aliasPath}],known:[{path:project,providerId:'codex'}],providers:['claude','codex']})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({id:expect.stringMatching(/^p-[0-9a-f]{20}$/),name:'My Project',path:realpathSync(project),providerId:'codex'})
  })

  it('gives same-basename directories distinct ids and excludes missing or non-directory paths',()=>{
    const area=root(),one=join(area,'one','project'),two=join(area,'two','project'),missing=join(area,'missing'),file=join(area,'file')
    mkdirSync(one,{recursive:true});mkdirSync(two,{recursive:true})
    writeFileSync(file,'not a directory')
    const rows=makeProjectCatalog({ownerChatId:'owner',registered:[],known:[{path:one,providerId:'claude'},{path:two,providerId:'claude'},{path:missing,providerId:'claude'},{path:file,providerId:'claude'}],providers:['claude']})
    expect(rows.map(row=>row.name)).toEqual([basename(one),basename(two)])
    expect(new Set(rows.map(row=>row.id)).size).toBe(2)
  })

  it('binds ids to the owner and current directory entity',()=>{
    const area=root(),project=join(area,'project');mkdirSync(project)
    const catalog=(ownerChatId:string)=>makeProjectCatalog({ownerChatId,registered:[{alias:'p',path:project}],known:[],providers:['claude']})[0]!
    const first=catalog('owner-a')
    expect(catalog('owner-b').id).not.toBe(first.id)
    renameSync(project,join(area,'old-project'));mkdirSync(project)
    expect(catalog('owner-a').id).not.toBe(first.id)
  })

  it('invalidates a project id when a registered symlink is retargeted',()=>{
    const area=root(),first=join(area,'first'),second=join(area,'second'),alias=join(area,'alias')
    mkdirSync(first);mkdirSync(second);symlinkSync(first,alias)
    const catalog=()=>makeProjectCatalog({ownerChatId:'owner',registered:[{alias:'project',path:alias}],known:[],providers:['claude']})[0]!
    const before=catalog();rmSync(alias);symlinkSync(second,alias);const after=catalog()
    expect(after.path).not.toBe(before.path)
    expect(after.id).not.toBe(before.id)
  })

  it('uses the newest available owner provider, then an available default, then the first available provider',()=>{
    const area=root(),history=join(area,'history'),fallback=join(area,'fallback'),first=join(area,'first'),none=join(area,'none')
    for(const path of [history,fallback,first,none])mkdirSync(path)
    const rows=makeProjectCatalog({
      ownerChatId:'owner',
      registered:[{alias:'history',path:history},{alias:'fallback',path:fallback},{alias:'first',path:first},{alias:'none',path:none}],
      known:[{path:history,providerId:'removed'},{path:history,providerId:'codex'}],
      providers:['claude','codex'],defaultProvider:'codex',
    })
    expect(rows.map(row=>[row.name,row.providerId])).toEqual([
      ['history','codex'],['fallback','codex'],['first','codex'],['none','codex'],
    ])
    expect(makeProjectCatalog({ownerChatId:'owner',registered:[{alias:'first',path:first}],known:[],providers:['claude','codex']})[0]!.providerId).toBe('claude')
    expect(makeProjectCatalog({ownerChatId:'owner',registered:[{alias:'none',path:none}],known:[],providers:[],defaultProvider:'codex'})[0]!.providerId).toBeNull()
  })
})
