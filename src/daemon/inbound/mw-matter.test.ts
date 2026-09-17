import {describe,expect,it,vi} from 'vitest'
import {makeMwMatter} from './mw-matter'
import type {InboundCtx} from './types'

const ctx=(chatId:string)=>({msg:{chatId}} as unknown as InboundCtx)

describe('mw-matter',()=>{
  it('registers the chat as a matter and always continues the pipeline',async()=>{
    const ensureChat=vi.fn(),next=vi.fn(async()=>{})
    await makeMwMatter({ensureChat,log:()=>{}})(ctx('chat-1'),next)
    expect(ensureChat).toHaveBeenCalledWith('chat-1');expect(next).toHaveBeenCalledOnce()
  })
  it('never lets a registry failure break the turn',async()=>{
    const log=vi.fn(),next=vi.fn(async()=>{})
    await makeMwMatter({ensureChat:()=>{throw new Error('disk_full')},log})(ctx('chat-1'),next)
    expect(next).toHaveBeenCalledOnce();expect(log).toHaveBeenCalledWith('MATTER',expect.stringContaining('disk_full'))
  })
})
