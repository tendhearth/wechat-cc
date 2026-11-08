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

async function run(source: 'claude' | 'codex', options: { context?: string; stall?: boolean; absent?: boolean; child?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cc-session-start-process-')); dirs.push(home)
  if (!options.absent) {
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      expect(request.headers.get('authorization')).toBe('Bearer offline-token')
      expect(await request.json()).toMatchObject({ source, session_id: 'offline-session', cwd: home })
      return options.stall ? new Response(new ReadableStream({ start() {} })) : Response.json({ context: options.context ?? 'CC 项目近况' })
    } })
    writeFileSync(join(home, 'token'), 'offline-token')
    writeFileSync(join(home, 'internal-api-info.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, tokenFilePath: join(home, 'token') }))
  }
  const started = performance.now()
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn('bun', [join(SOURCE_REPO_ROOT, 'cli.ts'), 'hook', source], {
      cwd: SOURCE_REPO_ROOT,
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), WECHAT_STATE_DIR: home, WECHAT_DISABLE_LOG_FILE: '1', WECHAT_CC_HOOK_DEBUG: '1', WECHAT_CC_DAEMON_CHILD: options.child ? '1' : '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { p.kill(); reject(new Error('SessionStart exceeded 1.5s')) }, 1500)
    p.stdout.on('data', b => { stdout += b }); p.stderr.on('data', b => { stderr += b })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'offline-session', cwd: home }))
  })
  expect(performance.now() - started).toBeLessThan(1500)
  return result
}

describe('real hook subprocess with temporary HOME / CODEX_HOME / WECHAT_STATE_DIR', () => {
  it.each(['claude', 'codex'] as const)('%s emits native startup JSON through the CLI entry', async source => {
    const r = await run(source)
    expect(r.code).toBe(0); expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CC 项目近况' } })
  })
  it.each([{ absent: true }, { stall: true }, { context: '' }, { child: true }])('failures are silent and do not block startup: %j', async options => {
    expect(await run('claude', options)).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})
