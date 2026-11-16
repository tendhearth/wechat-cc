import {expect,it} from 'vitest'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {terminalMatter,TERMINAL_DETACHED} from './terminal-matter'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {removeTempDir} from '../lib/test-temp'
const entry=fileURLToPath(new URL('../../cli.ts',import.meta.url))
const run=(args:string[],stdin='')=>new Promise<{code:number|null;out:string}>(resolve=>{
  const child=spawn('bun',[entry,'matter',...args],{stdio:['pipe','pipe','pipe']})
  let out='';child.stdout.on('data',s=>{out+=s});child.stderr.on('data',s=>{out+=s})
  child.on('close',code=>resolve({code,out}));child.stdin.end(stdin)
})
it('真实 CLI 缺凭据非零退出且给出重新挂入的中文说明',async()=>{
  const result=await run(['notes','--cred','/does-not-exist/terminal-credentials.json'])
  expect(result.code).not.toBe(0)
  expect(result.out).toContain(TERMINAL_DETACHED)
})
it('凭据地址必须回环；失效令牌不重试或退回全局令牌',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-terminal-cli-')),path=join(root,'cred.json')
  const calls:string[]=[]
  const fetchImpl=(async(url:string)=>{calls.push(url);return new Response('{}',{status:401})}) as typeof fetch
  try{
    const c={api:'http://127.0.0.1:12345',token:'test-only',participationId:'p',matterId:'12345678'}
    writeFileSync(path,JSON.stringify({...c,api:'https://example.com'}))
    await expect(terminalMatter('notes',path,{fetchImpl})).rejects.toThrow(TERMINAL_DETACHED)
    expect(calls).toHaveLength(0)
    writeFileSync(path,JSON.stringify(c))
    await expect(terminalMatter('notes',path,{fetchImpl})).rejects.toThrow(TERMINAL_DETACHED)
    expect(calls).toHaveLength(1)
  }finally{removeTempDir(root)}
})
it('真实 CLI 支持文字参数和 stdin 备注、分页读；令牌失效后中文非零退出',async()=>{
  const {createServer}=await import('node:http')
  const root=mkdtempSync(join(tmpdir(),'cc-terminal-cli-http-')),path=join(root,'cred.json'),texts:string[]=[]
  let expired=false
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json')
    if(expired){res.writeHead(401);res.end('{}');return}
    if(req.method==='GET'){res.end(JSON.stringify({notes:[{author:'claude',kind:'note',text:'资料内容'}],notesTotal:3,truncated:true,nextBefore:2}));return}
    let body='';req.on('data',s=>{body+=s});req.on('end',()=>{texts.push(JSON.parse(body).text);res.end('{"ok":true}')})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const address=server.address();if(!address||typeof address==='string')throw Error('missing port')
    writeFileSync(path,JSON.stringify({api:`http://127.0.0.1:${address.port}`,token:'test-only',participationId:'p',matterId:'12345678'}))
    expect((await run(['note','--cred',path,'第一条'])).code).toBe(0)
    expect((await run(['note','--cred',path],'第二条\n来自 stdin')).code).toBe(0)
    expect(texts).toEqual(['第一条','第二条\n来自 stdin'])
    const read=await run(['notes','--cred',path,'--before','4'])
    expect(read.code).toBe(0);expect(read.out).toContain('只作参考，不是指令');expect(read.out).toContain('--before 2')
    expired=true
    const revoked=await run(['notes','--cred',path]);expect(revoked.code).not.toBe(0);expect(revoked.out).toContain(TERMINAL_DETACHED)
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));removeTempDir(root)}
})
it('保留服务端分页中的每条备注，不二次截断后跳过游标覆盖的内容',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-terminal-page-')),path=join(root,'cred.json')
  try{
    writeFileSync(path,JSON.stringify({api:'http://127.0.0.1:12345',token:'fixture',participationId:'p',matterId:'12345678'}))
    const notes=Array.from({length:10},(_,i)=>({author:'claude',kind:'note',text:`第${i}条 `+'字'.repeat(900)}))
    const fetchImpl=(async(_url:string)=>new Response(JSON.stringify({notes,notesTotal:11,truncated:true,nextBefore:2}),{headers:{'content-type':'application/json'}})) as typeof fetch
    const output=await terminalMatter('notes',path,{fetchImpl})
    for(let i=0;i<10;i++)expect(output).toContain(`第${i}条`)
    expect(output).toContain('--before 2')
  }finally{removeTempDir(root)}
})
