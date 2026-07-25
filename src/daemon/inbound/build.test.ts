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
