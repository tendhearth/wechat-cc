import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { captureSimulatorFrames } from './macmini-ui-app.mjs'
test('captures only the selected lab simulator and drains a capture before stopping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-native-frames-')), controller = new AbortController(), calls = []
  try {
    const result = await captureSimulatorFrames({ directory, sim: ['simctl','--set','/lab/owned/simulators'], udid: 'owned-device', signal: controller.signal,
      execute: async (...args) => { calls.push(args); if (calls.length === 3) controller.abort() }, delay: async () => {} })
    expect(result.frames).toBe(3)
    expect(calls.map(c => c[2])).toEqual([0,1,2].map(i => ['simctl','--set','/lab/owned/simulators','io','owned-device','screenshot','--type=png',join(directory,`${String(i).padStart(3,'0')}.png`)]))
    expect(calls.every(c => c[1] === '/usr/bin/xcrun')).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('fails the flow if native capture fails instead of accepting empty evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-native-frames-'))
  try { await expect(captureSimulatorFrames({ directory, sim: ['simctl','--set','/lab/owned/simulators'], udid: 'owned-device', signal: new AbortController().signal, execute: async () => { throw Error('capture failed') } })).rejects.toThrow('capture failed') }
  finally { await rm(directory, { recursive: true, force: true }) }
})
