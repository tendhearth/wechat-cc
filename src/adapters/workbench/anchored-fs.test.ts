import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {closeSync,constants,mkdirSync,mkdtempSync,openSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdirAnchored,openAnchored,readBounded,verifyFromFilesystemRoot,verifyOpened} from './anchored-fs'
import {removeTempDir} from '../../lib/test-temp'

/**
 * 纯 JS 锚定层(替换 bun:ffi openat,2026-09-16)。上层的成果 / 附件 / API 文件测试各自钉住
 * 越界行为;这里只钉"先开再核"这个机制本身:描述符到手之后链路再变,必须被抓住。
 */
let root:string,outside:string
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-anchored-')));outside=realpathSync(mkdtempSync(join(tmpdir(),'cc-anchored-outside-')))})
afterEach(()=>{removeTempDir(root);removeTempDir(outside)})

describe('open, then verify',()=>{
  it('reads a nested regular file and refuses a link at any level',()=>{
    mkdirSync(join(root,'a','b'),{recursive:true});writeFileSync(join(root,'a','b','f.txt'),'ok')
    const fd=openAnchored(root,['a','b','f.txt'],constants.O_RDONLY,0,'nope')
    try{expect(readBounded(fd,16,'size','changed').bytes.toString()).toBe('ok')}finally{closeSync(fd)}
    symlinkSync(outside,join(root,'link'));writeFileSync(join(outside,'s.txt'),'secret')
    expect(()=>openAnchored(root,['link','s.txt'],constants.O_RDONLY,0,'nope')).toThrow('nope')
    symlinkSync(join(outside,'s.txt'),join(root,'a','leaf'))
    expect(()=>openAnchored(root,['a','leaf'],constants.O_RDONLY,0,'nope')).toThrow('nope')
  })

  // Windows 不许重命名里面还有打开句柄的目录(EPERM),这个夹具在那里搭不出来;机制本身与平台无关。
  it.skipIf(process.platform==='win32')('catches a parent swapped for a link after the descriptor was obtained',()=>{
    mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs','f.txt'),'ok')
    const fd=openSync(join(root,'docs','f.txt'),constants.O_RDONLY)
    try{
      expect(()=>verifyOpened(fd,root,['docs','f.txt'],'nope')).not.toThrow()
      renameSync(join(root,'docs'),join(root,'docs-real'));symlinkSync(outside,join(root,'docs'))
      writeFileSync(join(outside,'f.txt'),'other')
      expect(()=>verifyOpened(fd,root,['docs','f.txt'],'nope')).toThrow('nope')
    }finally{closeSync(fd)}
  })

  it('catches the leaf being replaced by a different file after open (identity mismatch)',()=>{
    writeFileSync(join(root,'f.txt'),'v1')
    const fd=openSync(join(root,'f.txt'),constants.O_RDONLY)
    try{
      rmSync(join(root,'f.txt'));writeFileSync(join(root,'f.txt'),'v2')
      expect(()=>verifyOpened(fd,root,['f.txt'],'nope')).toThrow('nope')
    }finally{closeSync(fd)}
  })

  it('creates directories level by level and refuses to walk through a link',()=>{
    expect(mkdirAnchored(root,['x','y'],'nope')).toBe(join(root,'x','y'))
    symlinkSync(outside,join(root,'z'))
    expect(()=>mkdirAnchored(root,['z','deeper'],'nope')).toThrow('nope')
    expect(()=>mkdirAnchored(root,['z'],'nope')).toThrow('nope')
  })

  it('checks every ancestor from the filesystem root',()=>{
    mkdirSync(join(root,'real'));symlinkSync(join(root,'real'),join(root,'alias'))
    expect(verifyFromFilesystemRoot(join(root,'real'),'nope').path).toBe(join(root,'real'))
    expect(()=>verifyFromFilesystemRoot(join(root,'alias'),'nope')).toThrow('nope')
  })
})
