import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {closeSync,constants,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdirAnchored,openAnchored,readAnchoredFile,readdirAnchored,verifyChain,verifyFromFilesystemRoot} from './anchored-fs'
import {removeLink,removeTempDir} from '../../lib/test-temp'

/**
 * 威胁模型的回归钉(docs/reference/workbench-file-guard.md)。
 *
 * 在范围内:agent / 用户的失误,以及项目里的路径把戏 —— `..`、指出去的链接(任何一级)、
 * 大小写 / Unicode 归一化别名、Windows 的 junction / ADS / 尾点别名。这些必须拒。
 * 不在范围内:与我们**并发**、专门挑两次 lstat 之间换目录的恶意本机进程(它已经有用户的权限)。
 * 但"先开再核"能抓到的那几种换法,这里照样钉住它们被拒;抓不到的那一种(硬链接)钉住
 * 我们接受的确切行为,免得以后有人以为它被挡了。
 */
const hooks=vi.hoisted(()=>({beforeOpen:null as null|((path:string)=>void),afterOpen:null as null|((path:string)=>void),afterMkdir:null as null|((path:string)=>void)}))
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>()
  return{...fs,
    openSync:(...args:unknown[])=>{
      const path=String(args[0]),before=hooks.beforeOpen,after=hooks.afterOpen
      hooks.beforeOpen=null;hooks.afterOpen=null
      before?.(path)
      const fd=Reflect.apply(fs.openSync,fs,args) as number
      after?.(path)
      return fd
    },
    mkdirSync:(...args:unknown[])=>{
      const result=Reflect.apply(fs.mkdirSync,fs,args)
      hooks.afterMkdir?.(String(args[0]))
      return result
    },
  }
})

const POSIX=process.platform!=='win32'
let root:string,outside:string
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-anchored-tm-')))
  outside=realpathSync(mkdtempSync(join(tmpdir(),'cc-anchored-tm-outside-')))
  hooks.beforeOpen=hooks.afterOpen=hooks.afterMkdir=null
})
afterEach(()=>{removeTempDir(root);removeTempDir(outside)})

/** root/a/b/c/f.txt 与 outside 下同形的一棵树(内容不同),换链接时两边都"看起来对"。 */
function mirrored(){
  for(const base of [root,outside]){mkdirSync(join(base,'a','b','c'),{recursive:true})}
  writeFileSync(join(root,'a','b','c','f.txt'),'inside')
  writeFileSync(join(outside,'a','b','c','f.txt'),'outside')
}
/** 把 root 下的第 depth 级目录换成指向 outside 同一位置的链接(原目录挪到旁边)。 */
function swapToLink(depth:number,parts=['a','b','c']){
  const rel=parts.slice(0,depth+1),path=join(root,...rel)
  renameSync(path,`${path}-real`);symlinkSync(join(outside,...rel),path,'dir')
  return ()=>{removeLink(path);renameSync(`${path}-real`,path)}
}
const read=(fd:number)=>{try{return readFileSync(fd,'utf8')}finally{closeSync(fd)}}

describe('in scope: a link at any level is refused',()=>{
  it.skipIf(!POSIX)('every level of a nested path, for open / read / mkdir / readdir',()=>{
    mirrored()
    for(const depth of [0,1,2]){
      const restore=swapToLink(depth)
      try{
        expect(()=>openAnchored(root,['a','b','c','f.txt'],constants.O_RDONLY,0,'nope')).toThrow('nope')
        expect(()=>readAnchoredFile(root,'a/b/c/f.txt',64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
        expect(()=>mkdirAnchored(root,['a','b','c','new'],'nope')).toThrow('nope')
        expect(()=>readdirAnchored(root,['a','b','c'],'nope')).toThrow('nope')
        expect(()=>verifyFromFilesystemRoot(join(root,'a','b','c'),'nope')).toThrow('nope')
      }finally{restore()}
    }
    expect(existsSync(join(outside,'a','b','c','new'))).toBe(false)
    // 叶子本身是链接,也拒(O_CREAT 时同样:不能借一个指出去的悬空链接在外面建文件)。
    symlinkSync(join(outside,'a','b','c','f.txt'),join(root,'a','b','c','leaf'))
    symlinkSync(join(outside,'dangling'),join(root,'a','b','c','dangling'))
    expect(()=>openAnchored(root,['a','b','c','leaf'],constants.O_RDONLY,0,'nope')).toThrow('nope')
    expect(()=>openAnchored(root,['a','b','c','dangling'],constants.O_WRONLY|constants.O_CREAT,0o600,'nope')).toThrow('nope')
    expect(existsSync(join(outside,'dangling'))).toBe(false)
    expect(read(openAnchored(root,['a','b','c','f.txt'],constants.O_RDONLY,0,'nope'))).toBe('inside')
  })

  it.skipIf(!POSIX)('a link that points back inside the project is refused too (links are refused, not judged)',()=>{
    mkdirSync(join(root,'real'));writeFileSync(join(root,'real','f.txt'),'ok')
    symlinkSync(join(root,'real'),join(root,'alias'))
    expect(()=>readAnchoredFile(root,'alias/f.txt',64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
  })
})

describe('in scope: `..` and dot segments',()=>{
  it('`..` in a relative name is refused before anything is resolved, including after a link',()=>{
    mkdirSync(join(root,'d'));writeFileSync(join(root,'f.txt'),'ok')
    if(POSIX)symlinkSync(join(outside),join(root,'link'))
    for(const name of ['../f.txt','d/../f.txt','link/../f.txt','link/..','./f.txt','d//f.txt',''])
      expect(()=>readAnchoredFile(root,name,64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
    for(const parts of [['..'],['d','..'],['link','..','f.txt'],['.'],['']])
      expect(()=>openAnchored(root,parts,constants.O_RDONLY,0,'nope')).toThrow('nope')
  })

  // base 是调用方给的可信锚点,但 `<root>/link/..` 这种写法里,内核会先跟进 link 再取父目录,
  // 而 path.join 是按字面把 `link/..` 消掉的 —— 两者指向不同目录。锚点里带点段一律拒。
  it.skipIf(!POSIX)('a base containing `..` after a link is refused (kernel and path.join would disagree)',()=>{
    mkdirSync(join(outside,'inner'));symlinkSync(join(outside,'inner'),join(root,'link'))
    writeFileSync(join(outside,'f.txt'),'outside');writeFileSync(join(root,'f.txt'),'inside')
    const base=`${root}/link/..`
    expect(()=>verifyChain(base,[],'nope')).toThrow('nope')
    expect(()=>openAnchored(base,['f.txt'],constants.O_RDONLY,0,'nope')).toThrow('nope')
    expect(()=>mkdirAnchored(base,['x'],'nope')).toThrow('nope')
    expect(()=>verifyFromFilesystemRoot(base,'nope')).toThrow('nope')
    expect(()=>verifyChain(`${root}/.`,[],'nope')).toThrow('nope')
  })
})

/** 根目录所在卷是否大小写不敏感(macOS APFS 默认是;case-sensitive APFS 与 Linux 不是)。 */
function caseInsensitive(dir:string):boolean{
  try{return lstatSync(dir.toUpperCase()).ino===lstatSync(dir).ino}catch{return false}
}

describe('in scope: case and Unicode aliases (macOS)',()=>{
  it.runIf(process.platform==='darwin')('an alias spelling of a link is still the link, and is refused',()=>{
    if(!caseInsensitive(root))return
    mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs','f.txt'),'inside');writeFileSync(join(outside,'f.txt'),'outside')
    symlinkSync(outside,join(root,'link'))
    for(const name of ['LINK/f.txt','Link/f.txt','link/F.TXT'])
      expect(()=>readAnchoredFile(root,name,64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
    expect(()=>mkdirAnchored(root,['LINK','x'],'nope')).toThrow('nope')
    expect(existsSync(join(outside,'x'))).toBe(false)
    // 别名指向项目里真实的文件 ⇒ 允许:读到的是项目里那一份,没有越界。钉住这一点免得以后误改成"按大小写比字面"。
    expect(readAnchoredFile(root,'DOCS/F.TXT',64,{path:'nope',size:'size',changed:'changed'}).toString()).toBe('inside')
  })

  it.runIf(process.platform==='darwin')('NFC and NFD spellings of a linked directory are both refused',()=>{
    const nfc='café',nfd='café'
    symlinkSync(outside,join(root,nfc));writeFileSync(join(outside,'f.txt'),'outside')
    for(const name of [nfc,nfd]){
      expect(()=>readAnchoredFile(root,`${name}/f.txt`,64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
    }
  })
})

describe('in scope: Windows path aliases',()=>{
  it.runIf(process.platform==='win32')('a junction at any level is refused (junctions need no privilege, so they are the realistic Windows link)',()=>{
    mkdirSync(join(root,'a','b'),{recursive:true});writeFileSync(join(outside,'f.txt'),'outside')
    symlinkSync(outside,join(root,'junc'),'junction')
    symlinkSync(outside,join(root,'a','b','junc'),'junction')
    for(const name of ['junc\\f.txt','a\\b\\junc\\f.txt','JUNC\\f.txt'])
      expect(()=>readAnchoredFile(root,name,64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
    expect(()=>mkdirAnchored(root,['junc','x'],'nope')).toThrow('nope')
    expect(()=>readdirAnchored(root,['junc'],'nope')).toThrow('nope')
    expect(()=>verifyFromFilesystemRoot(join(root,'junc'),'nope')).toThrow('nope')
    expect(existsSync(join(outside,'x'))).toBe(false)
  })

  // `f.txt:stream` 是同一个文件的另一条数据流(ADS):不越界,但能把内容藏在列表看不到的地方;
  // `junc.` / `junc ` 会被 Win32 路径归一化成 `junc`。这几种别名在组件里一律拒,不去猜系统怎么解析。
  it.runIf(process.platform==='win32')('ADS and trailing dot / space aliases are refused as path components',()=>{
    writeFileSync(join(root,'f.txt'),'inside')
    for(const name of ['f.txt:hidden','f.txt::$DATA','f.txt.','f.txt '])
      expect(()=>readAnchoredFile(root,name,64,{path:'nope',size:'size',changed:'changed'})).toThrow('nope')
    expect(()=>openAnchored(root,['f.txt:hidden'],constants.O_WRONLY|constants.O_CREAT,0o600,'nope')).toThrow('nope')
    expect(()=>mkdirAnchored(root,['d.'],'nope')).toThrow('nope')
  })

  it.skipIf(process.platform==='win32')('outside Windows, `:` and trailing dots are ordinary name characters',()=>{
    writeFileSync(join(root,'a:b'),'colon');writeFileSync(join(root,'f.'),'dot')
    expect(readAnchoredFile(root,'a:b',64,{path:'nope',size:'size',changed:'changed'}).toString()).toBe('colon')
    expect(readAnchoredFile(root,'f.',64,{path:'nope',size:'size',changed:'changed'}).toString()).toBe('dot')
  })
})

// Windows 不许重命名里面有打开句柄的目录,这些换目录的夹具在那里搭不出来;机制与平台无关。
describe.skipIf(!POSIX)('concurrent directory replacement (TOCTOU)',()=>{
  it('caught: a parent swapped for a link between the pre-check and the open',()=>{
    mirrored()
    for(const depth of [0,1,2]){
      let restore:(()=>void)|null=null
      hooks.beforeOpen=()=>{restore=swapToLink(depth)}
      try{expect(()=>openAnchored(root,['a','b','c','f.txt'],constants.O_RDONLY,0,'nope')).toThrow('nope')}
      finally{(restore as (()=>void)|null)?.()}
    }
  })

  it('caught: swapped for a link before the open and swapped back before the re-check (identity differs)',()=>{
    mirrored()
    let restore:(()=>void)|null=null
    hooks.beforeOpen=()=>{restore=swapToLink(1)}
    hooks.afterOpen=()=>{restore?.()}
    expect(()=>openAnchored(root,['a','b','c','f.txt'],constants.O_RDONLY,0,'nope')).toThrow('nope')
  })

  it('caught: O_CREAT through a parent swapped mid-open is refused (the stray file outside is the accepted residue)',()=>{
    mirrored()
    let restore:(()=>void)|null=null
    hooks.beforeOpen=()=>{restore=swapToLink(2)}
    try{expect(()=>openAnchored(root,['a','b','c','new.txt'],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600,'nope')).toThrow('nope')}
    finally{(restore as (()=>void)|null)?.()}
    // 我们拒绝使用那个描述符,但内核已经在外面建了一个空文件 —— 不写内容,也不报给调用方用。
    expect(existsSync(join(outside,'a','b','c','new.txt'))).toBe(true)
    expect(readFileSync(join(outside,'a','b','c','new.txt'),'utf8')).toBe('')
  })

  it('caught: mkdirAnchored notices an already-created level turned into a link before the next level',()=>{
    // x 建好、核过之后,y 建完的那一刻 x 被换成指向外面同形目录的链接。逐级只 lstat 叶子的话,
    // `x/y` 会穿过链接 lstat 到外面那个真目录、照常往下建 z —— 每一级都得从锚点重核整条链。
    mkdirSync(join(outside,'x','y'),{recursive:true})
    hooks.afterMkdir=path=>{
      if(path!==join(root,'x','y'))return
      hooks.afterMkdir=null
      renameSync(join(root,'x'),join(root,'x-real'));symlinkSync(join(outside,'x'),join(root,'x'),'dir')
    }
    try{expect(()=>mkdirAnchored(root,['x','y','z'],'nope')).toThrow('nope')}
    finally{removeLink(join(root,'x'))}
    expect(existsSync(join(outside,'x','y','z'))).toBe(false)
  })

  it('caught: a directory returned by mkdirAnchored, swapped before the caller opens the file under it',()=>{
    mirrored()
    // 正确的用法是从锚点(root)打开整条链,而不是从 mkdirAnchored 返回的深层路径开始。
    mkdirAnchored(root,['a','b','c'],'nope')
    const restore=swapToLink(0)
    try{expect(()=>openAnchored(root,['a','b','c','g.txt'],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600,'nope')).toThrow('nope')}
    finally{restore()}
  })

  it('accepted (contract): the base is trusted — opening from a deep path does not re-check the levels above it',()=>{
    // 这条钉的是 API 契约而不是漏洞:base 的祖先不核。所以调用方必须从锚点(项目 / 状态目录)开整条链。
    mirrored()
    const deep=mkdirAnchored(root,['a','b','c'],'nope')
    const restore=swapToLink(0)
    try{expect(read(openAnchored(deep,['f.txt'],constants.O_RDONLY,0,'nope'))).toBe('outside')}
    finally{restore()}
  })

  it('accepted (out of scope): a hard link inside the project to a file outside reads the outside bytes',()=>{
    // 一条不含链接的路径解析到项目外的文件,只有硬链接(和挂载点)能做到;openat 方案同样拦不住。
    // 能建硬链接的进程本来就能把那份内容复制进项目。API 文件的上传分片另外要求 nlink === 1。
    writeFileSync(join(outside,'secret.txt'),'outside')
    try{linkSync(join(outside,'secret.txt'),join(root,'hard.txt'))}catch{return /* 跨卷的 tmpdir 建不了硬链接 */}
    expect(readAnchoredFile(root,'hard.txt',64,{path:'nope',size:'size',changed:'changed'}).toString()).toBe('outside')
  })
})
