import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type Server } from '../lib/runtime/http'
import { SOURCE_REPO_ROOT } from './repo-root'

let server: Server | undefined
const dirs: string[] = []
afterEach(async () => { await server?.stop(true); server = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function run(source: 'claude' | 'codex', options: { context?: string; stall?: boolean; timeout?: boolean; absent?: boolean; child?: boolean; budgetMs?: number; production?: boolean; delayMs?: number; stdinDelayMs?: number; unfinishedStdin?: boolean; isolate?: boolean; event?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cc-session-start-process-')); dirs.push(home)
  const requests: { url: string; auth: string | null; body: unknown }[] = []
  if (!options.absent) {
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      requests.push({ url: new URL(request.url).pathname, auth: request.headers.get('authorization'), body: await request.json() })
      if (options.timeout) return new Promise<Response>(() => {})
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      // Send headers and a partial body so this really tests body consumption on Node too.
      return options.stall ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } })) : Response.json({ context: options.context ?? 'CC 项目近况' })
    } })
    await server.ready
    writeFileSync(join(home, 'token'), 'offline-token')
    writeFileSync(join(home, 'internal-api-info.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, tokenFilePath: join(home, 'token') }))
  }
  const preload = join(home, 'isolate.ts')
  if (options.isolate) writeFileSync(preload, `import { plugin } from 'bun'
plugin({ name: 'session-start-isolation', setup(build) {
  build.onLoad({ filter: /(?:\\/cli\\/(?:commands\\/|main\\.ts$|hook\\.ts$)|\\/protocol\\/src\\/desktop-api\\.ts$)/ }, args => {
    throw new Error('SessionStart loaded an unrelated module: ' + args.path)
  })
} })`)
  const started = performance.now()
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn('bun', [...(options.isolate ? ['--preload', preload] : []), join(SOURCE_REPO_ROOT, 'cli.ts'), 'hook', source], {
      cwd: SOURCE_REPO_ROOT,
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), WECHAT_STATE_DIR: home, WECHAT_DISABLE_LOG_FILE: '1', WECHAT_CC_HOOK_DEBUG: options.event ? '' : '1', WECHAT_CC_DAEMON_CHILD: options.child ? '1' : '', NODE_ENV: options.production ? 'production' : 'test', WECHAT_CC_TEST_SESSION_START_BUDGET_MS: String(options.budgetMs ?? '') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { p.kill(); reject(new Error('SessionStart exceeded 1.5s')) }, 1500)
    p.stdout.on('data', b => { stdout += b }); p.stderr.on('data', b => { stderr += b })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    p.stdin.on('error', () => { /* a silent deadline may close stdin before its writer */ })
    if (!options.unfinishedStdin) {
      const input = JSON.stringify({ hook_event_name: options.event ?? 'SessionStart', session_id: 'offline-session', cwd: home })
      if (options.stdinDelayMs) setTimeout(() => p.stdin.end(input), options.stdinDelayMs)
      else p.stdin.end(input)
    }
  })
  expect(performance.now() - started).toBeLessThan(1500)
  if (options.absent || options.child || options.unfinishedStdin || result.code !== 0) expect(requests).toEqual([])
  else expect(requests).toEqual([{ url: options.event ? '/v1/cli/event' : '/v1/cli/project-memory', auth: 'Bearer offline-token', body: options.event
    ? { source, kind: 'session_end', session_id: 'offline-session', cwd: home }
    : { source, session_id: 'offline-session', cwd: home } }])
  return result
}

describe('real hook subprocess with temporary HOME / CODEX_HOME / WECHAT_STATE_DIR', () => {
  it.each(['claude', 'codex'] as const)('%s emits native startup JSON through the CLI entry', async source => {
    const r = await run(source, { budgetMs: 10_000 })
    expect(r.code).toBe(0); expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CC 项目近况' } })
  })
  it.each([{ absent: true }, { stall: true }, { context: '' }, { child: true }])('failures are silent and do not block startup: %j', async options => {
    expect(await run('claude', options)).toEqual({ code: 0, stdout: '', stderr: '' })
  })
  it.each(['claude', 'codex'] as const)('%s starts without loading other commands, event relays or desktop schemas', async source => {
    const r = await run(source, { budgetMs: 10_000, isolate: true })
    expect(r.code, r.stderr).toBe(0); expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CC 项目近况' } })
  })
  it('starts the injected request budget after stdin arrives', async () => {
    const r = await run('claude', { budgetMs: 10_000, stdinDelayMs: 250, delayMs: 700 })
    expect(r.code).toBe(0); expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('CC 项目近况')
  })
  it('request header timeout is silent even in debug mode', async () => {
    expect(await run('claude', { timeout: true })).toEqual({ code: 0, stdout: '', stderr: '' })
  })
  it('does not wait forever for stdin to finish', async () => {
    expect(await run('codex', { unfinishedStdin: true })).toEqual({ code: 0, stdout: '', stderr: '' })
  })
  it('ignores test-only budget injection in production', async () => {
    expect(await run('claude', { budgetMs: 10_000, production: true, delayMs: 700 })).toEqual({ code: 0, stdout: '', stderr: '' })
  })
  it('forwards the already-read input to the existing non-startup relay', async () => {
    expect(await run('codex', { event: 'SessionEnd' })).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})
