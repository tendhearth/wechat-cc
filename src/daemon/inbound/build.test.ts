import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// build.ts wires middlewares by source order; assert transcribe-voice sits
// AFTER attachments and BEFORE activity (dispatch reads the transcribed text).
describe('inbound pipeline order — transcribe-voice', () => {
  it('makeMwTranscribeVoice is composed after attachments, before activity', () => {
    const src = readFileSync(join(__dirname, 'build.ts'), 'utf8')
    const iAtt = src.indexOf('makeMwAttachments(')
    const iStt = src.indexOf('makeMwTranscribeVoice(')
    const iAct = src.indexOf('makeMwActivity(')
    expect(iAtt).toBeGreaterThan(-1)
    expect(iStt).toBeGreaterThan(iAtt)
    expect(iAct).toBeGreaterThan(iStt)
  })
})

// 意图路由第三步(c):链上只剩一站消费(mw-consume);副作用站的先后按原链保住。
describe('inbound pipeline order — route / consume', () => {
  it('typing → attachments → transcribe-voice → route → guard → activity → consume → recall', () => {
    const src = readFileSync(join(__dirname, 'build.ts'), 'utf8')
    const at = (s: string) => { const i = src.indexOf(s, src.indexOf('return compose([')); expect(i, s).toBeGreaterThan(-1); return i }
    const order = ['makeMwTyping(', 'makeMwAttachments(', 'makeMwTranscribeVoice(', '...(route?[route]:[])', 'makeMwGuard(', 'makeMwActivity(', '    consume,', 'makeMwRecall(']
    for (let i = 1; i < order.length; i++) expect(at(order[i]!), `${order[i - 1]} < ${order[i]}`).toBeGreaterThan(at(order[i - 1]!))
  })
})
