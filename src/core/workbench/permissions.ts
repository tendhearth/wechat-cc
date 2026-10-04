import { randomUUID } from 'node:crypto'

export const WORKBENCH_PERMISSION_TIMEOUT_MS = 5 * 60_000
export const WORKBENCH_PERMISSION_TOOL_MAX = 160
export const WORKBENCH_PERMISSION_DESCRIPTION_MAX = 20_000

export type PermissionDecision = 'allow' | 'deny'
export type PermissionOutcome = PermissionDecision | 'aborted' | 'expired' | 'cancelled' | 'ended'

export interface PendingWorkbenchPermission {
  id: string
  taskId: string
  tool: string
  description: string
  createdAt: number
}

export type WorkbenchPermissionAudit =
  | { type: 'request'; permission: PendingWorkbenchPermission }
  | { type: 'outcome'; permission: PendingWorkbenchPermission; outcome: PermissionOutcome }

interface Entry {
  permission: PendingWorkbenchPermission
  expiresAt: number
  finish: (allowed: boolean, outcome: PermissionOutcome) => void
  /** 冻住期间撤掉的到期计时器,放开时按剩下的时间重起(网络守护暂停,2026-10-03)。 */
  rearm: (ms: number) => void
  disarm: () => void
}

export function makeRunPermissions(opts: {
  taskId: string
  timeoutMs?: number
  audit?: (event: WorkbenchPermissionAudit) => void
}) {
  const entries = new Map<string, Entry>()
  let closed = false
  /** 暂停时刻(网络守护把执行者冻住时):期间不算进五分钟的批准期限。null = 没暂停。 */
  let pausedAt: number | null = null
  const audit = (event: WorkbenchPermissionAudit): boolean => {
    try { opts.audit?.(event); return true } catch { return false }
  }

  function request(
    raw: { tool: string; description: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (closed || typeof raw?.tool !== 'string' || typeof raw?.description !== 'string') return Promise.resolve(false)
    const tool = raw.tool.trim()
    const description = raw.description.trim()
    if (!tool || !description || tool.length > WORKBENCH_PERMISSION_TOOL_MAX ||
        description.length > WORKBENCH_PERMISSION_DESCRIPTION_MAX || signal?.aborted) return Promise.resolve(false)

    const permission: PendingWorkbenchPermission = {
      id: randomUUID(),
      taskId: opts.taskId,
      tool,
      description,
      createdAt: Date.now(),
    }
    return new Promise<boolean>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.finish(false, 'aborted')
      const finish = (allowed: boolean, outcome: PermissionOutcome) => {
        if (settled) return
        settled = true
        entries.delete(permission.id)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const audited = audit({ type: 'outcome', permission, outcome })
        resolve(audited ? allowed : false)
      }
      const timeoutMs = opts.timeoutMs ?? WORKBENCH_PERMISSION_TIMEOUT_MS
      const rearm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(false, 'expired'), Math.max(0, ms)); timer.unref?.() }
      const disarm = () => { if (timer) clearTimeout(timer); timer = undefined }
      const entry: Entry = { permission, expiresAt:permission.createdAt + Math.max(0,timeoutMs), finish, rearm, disarm }
      entries.set(permission.id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (pausedAt === null) rearm(timeoutMs)
      if (!audit({ type: 'request', permission })) finish(false,'ended')
    })
  }

  return {
    request,
    pending: (): PendingWorkbenchPermission[] => Array.from(entries.values(), entry => ({ ...entry.permission })),
    /** 网络守护冻住执行者:批准期限停表(到期计时器撤掉;放开时期限按冻住的时长顺延)。 */
    pause(): void {
      if (pausedAt !== null) return
      pausedAt = Date.now()
      for (const entry of entries.values()) entry.disarm()
    },
    /** 放开:冻住的那段不算,期限顺延,计时器按剩下的时间重起。 */
    resume(): void {
      if (pausedAt === null) return
      const held = Date.now() - pausedAt
      pausedAt = null
      for (const entry of entries.values()) { entry.expiresAt += held; entry.rearm(entry.expiresAt - Date.now()) }
    },
    resolve(id: string, decision: PermissionDecision): boolean {
      const entry = entries.get(id)
      if (!entry) return false
      if (pausedAt === null && Date.now() >= entry.expiresAt) {
        entry.finish(false,'expired')
        return false
      }
      entry.finish(decision === 'allow', decision)
      return true
    },
    rejectAll(outcome: Extract<PermissionOutcome, 'cancelled' | 'ended'> = 'ended'): void {
      closed = true
      for (const entry of [...entries.values()]) entry.finish(false, outcome)
    },
  }
}

export type RunPermissions = ReturnType<typeof makeRunPermissions>
