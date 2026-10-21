import {describe,expect,it} from 'vitest'
import {PHONE_SCRIPT_LINES,phoneLine,phoneScripts,scriptTail} from './phone-scripts'

describe('工作区脚本到手机的投影(2026-10-20)',()=>{
  it('没配脚本 / 读不懂 ⇒ 只有端口(有的话),不带状态',()=>{
    expect(phoneScripts(null,47100,[],[])).toEqual({port:47100})
    expect(phoneScripts({configured:false} as never,undefined,[],[])).toEqual({})
  })
  it('配了:状态原样、批没批、最近那条脚本的最后几行;脚本原文从不带',()=>{
    const scripts={configured:true,approved:false,hash:'h',config:{setup:'bun i',run:'SECRET_CMD --serve',archive:null},setup:'done',run:'running',archiving:false}
    const events=[{activity:{id:'script-a',output:'old'}},{activity:{id:'tool-1',output:'not a script'}},{activity:{id:'script-b',output:'one\ntwo\n'}},{kind:'text'}]
    const out=phoneScripts(scripts as never,47101,events,[])
    expect(out).toEqual({port:47101,setup:'done',run:'running',approved:false,lastLines:['one','two']})
    expect(JSON.stringify(out)).not.toContain('SECRET_CMD')
  })
  it('只留最后几行;\\r 进度条只留最后一截;去颜色码',()=>{
    const output=Array.from({length:30},(_,i)=>`line ${i}`).join('\n')+'\n\x1b[32mready\x1b[0m 10%\r100%'
    const lines=scriptTail([{activity:{id:'script-x',output}}],[])!
    expect(lines).toHaveLength(PHONE_SCRIPT_LINES);expect(lines.at(-1)).toBe('100%')
    expect(scriptTail([{activity:{id:'script-x',output:'\x1b[1mok\x1b[0m'}}],[])).toEqual(['ok'])
  })
  it('路径:工作区 / 项目根换成「.」,其余绝对路径只留最后一段;http://host/ 不动',()=>{
    const roots=['/Users/me/.wt/abc','/Users/me/proj']
    expect(phoneLine('error in /Users/me/.wt/abc/src/a.ts:3',roots)).toBe('error in ./src/a.ts:3')
    expect(phoneLine('read /Users/me/proj/package.json',roots)).toBe('read ./package.json')
    expect(phoneLine('cache at /Users/other/Library/x/cache.db',roots)).toBe('cache at …/cache.db')
    expect(phoneLine('open "C:\\Users\\me\\a.txt"',[])).toBe('open "…/a.txt"')
    expect(phoneLine('Local: http://localhost:47100/app',[])).toBe('Local: http://localhost:47100/app')
    expect(phoneLine('/var/folders/zz/log.txt failed',[])).toBe('…/log.txt failed')
    expect([...phoneLine('x'.repeat(500),[])].length).toBe(200)
  })
})
