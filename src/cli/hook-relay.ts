// Existing permission/event relay, loaded only after the native startup path is excluded.
import { STATE_DIR } from '../lib/config'
import type { HookSource } from './hook'

export async function relayHookPayload(source: HookSource, parsed: unknown): Promise<void> {
  const { normalizeHookPayload, postCliEvent, parsePermissionRequest, relayPermission, permissionDecisionOutput, withMachineContext, cursorPermissionOutput, cursorEventOutput, withCursorStopText } = await import('./hook')
  const debug = process.env['WECHAT_CC_HOOK_DEBUG'] === '1'
  try {
    // PermissionRequest:去微信问主人;拿到 y/n 就往 stdout 写答复(两家同形状)。
    // 主人在场 / 没答 / daemon 没跑 → 什么都不写,终端自己弹提示;顺手按老规矩
    // 压一条「等你批准」提醒(刚发过卡片的话 daemon 那头会压掉)。
    // Cursor:没拿到主人的决定就回 ask(Cursor 自己问),绝不放行。
    const perm = parsePermissionRequest(source, parsed)
    if (perm) {
      const r = await relayPermission(STATE_DIR, await withMachineContext(perm))
      if (debug) console.error(`hook: permission ${JSON.stringify(r)}`)
      if (source === 'cursor') process.stdout.write(cursorPermissionOutput(r.decision) + '\n')
      if (r.decision) { if (source !== 'cursor') process.stdout.write(permissionDecisionOutput(r.decision) + '\n'); return }
      await postCliEvent(STATE_DIR, await withMachineContext({ source, kind: 'permission' as const, session_id: perm.session_id, cwd: perm.cwd, text: perm.summary ? `${perm.tool_name}: ${perm.summary}` : perm.tool_name }))
      return
    }
    // Cursor 的其余事件先回放行,再报 daemon(不让主人的提交卡在 daemon 上)。
    if (source === 'cursor') process.stdout.write(cursorEventOutput(parsed) + '\n')
    const norm = normalizeHookPayload(source, parsed)
    if (!norm) { if (debug) console.error('hook: event ignored'); return }
    const ev = withCursorStopText(norm)
    // prompt / session_end 不用探空闲(它们本身就说明有人在);stop / permission 要。
    const r = await postCliEvent(STATE_DIR, ev.kind === 'stop' || ev.kind === 'permission' ? await withMachineContext(ev) : ev)
    if (debug) console.error(`hook: ${JSON.stringify(r)}`)
  } catch (err) {
    if (debug) console.error(`hook: ${err instanceof Error ? err.message : String(err)}`)
  }
}
