import { afterEach, expect, it, vi } from 'vitest'
import { createAgyAgentProvider } from './agy/agy-agent-provider'
import { createAcpCursorChatProvider } from './acp/acp-cursor-chat'
import { TIER_PROFILES } from '../../domain/user-tier'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const boundary: Array<[string[], { env?: NodeJS.ProcessEnv }]> = []
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); boundary.length = 0 })

function captureCli(output: string) {
  if (typeof Bun !== 'undefined') {
    vi.spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      boundary.push([args, options])
      return { stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(output)); c.close() } }),
        stderr: new ReadableStream({ start(c) { c.close() } }), exited: Promise.resolve(0), kill() {} }
    }) as never)
  } else {
    const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
    vi.spyOn(cp, 'spawn').mockImplementation(((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      boundary.push([[command, ...args], options])
      const child = Object.assign(new EventEmitter(), { pid: 999999, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
      queueMicrotask(() => { child.stdout.end(output); child.stderr.end(); child.emit('exit', 0) })
      return child
    }) as never)
  }
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'CLI_AMBIENT_SECRET_CANARY')
}
function cleanSpawns(count: number) {
  expect(boundary).toHaveLength(count)
  for (const [args, options] of boundary) {
    // An omitted env inherits process.env and is unsafe as well.
    expect([...args, ...Object.values(options.env ?? process.env) as string[]].some(v => v?.includes('SECRET_CANARY'))).toBe(false)
    expect(options.env!.PATH).toBe(process.env.PATH)
  }
}

it('agy dispatch, resumed dispatch, cheap and strong eval spawn argv/general env exclude session tokens', async () => {
  captureCli(JSON.stringify({ event: 'result', result: { conversation_id: 'offline', status: 'SUCCESS', response: 'offline', num_turns: 1 } }) + '\n')
  const provider = createAgyAgentProvider({ bin: '/offline/agy', model: 'm', log: () => {} })
  for (const resumeSessionId of [undefined, 'old']) {
    const session = await provider.spawn({ alias: 'p', path: '/project' }, { chatId: 'owner', tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', resumeSessionId,
      mcpEnv: { WECHAT_SESSION_TOKEN: 'AGY_SESSION_SECRET_CANARY' } })
    try { for await (const event of session.dispatch('offline')) void event } finally { await session.close() }
  }
  await provider.cheapEval!('offline'); await provider.strongEval!('offline')
  cleanSpawns(4)
})

it('Cursor cheap and strong eval default spawn argv/general env exclude session tokens', async () => {
  captureCli(JSON.stringify({ type: 'result', subtype: 'success', result: 'offline' }) + '\n')
  const provider = createAcpCursorChatProvider({ bin: '/offline/cursor', model: 'auto', log: () => {}, mcpSpecs: { wechat: null, delegate: null } })
  await provider.cheapEval!('offline'); await provider.strongEval!('offline')
  cleanSpawns(2)
})
