import { CliProjectMemoryRequest } from '../../packages/protocol/src/cli-project-memory'
import { readApiInfo, shouldSkipHook } from './hook-api'
import type { HookSource } from './hook'
import { sessionStartBudget } from './hook-session-start-budget'

export async function sessionStartOutput(stateDir: string, source: HookSource, raw: unknown, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; deadlineAt?: number; env?: Record<string, string | undefined> } = {}): Promise<string> {
  const { requestMs } = sessionStartBudget(opts.env)
  const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, performance.now() + Math.min(opts.timeoutMs ?? requestMs, requestMs))
  if (source === 'cursor' || shouldSkipHook(opts.env ?? process.env) || !raw || typeof raw !== 'object') return ''
  const input = raw as Record<string, unknown>
  if (input['hook_event_name'] !== 'SessionStart' || input['agent_id']) return ''
  const parsed = CliProjectMemoryRequest.safeParse({ source, session_id: input['session_id'], cwd: input['cwd'] })
  if (!parsed.success) return ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  try {
    const api = readApiInfo(stateDir)
    if ('reason' in api) return ''
    const remainingMs = deadlineAt - performance.now()
    if (remainingMs <= 0) return ''
    const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), remainingMs) })
    const operation = async () => {
      const res = await (opts.fetchImpl ?? fetch)(`${api.baseUrl}/v1/cli/project-memory`, {
        method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data), signal: controller.signal,
      })
      if (!res.ok) return ''
      const body = await res.json() as { context?: unknown }
      if (typeof body?.context !== 'string' || !body.context.trim() || [...body.context].length > 1200) return ''
      if (performance.now() >= deadlineAt) return ''
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body.context } })
    }
    return await Promise.race([operation(), timeout])
  } catch { return '' }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort() }
}
