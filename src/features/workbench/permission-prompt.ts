import type { WechatPermissions } from '../../ports/wechat'
import type { ServiceDeps } from './service/ctx'
import { WORKBENCH_PERMISSION_TIMEOUT_MS } from '../../adapters/workbench/permissions'

/** One pending card shared by WeChat codes and the desktop pet; a settlement on
 * any workbench surface removes the code through the returned disposer. */
export function makeWorkbenchPermissionPrompt(registry: Pick<WechatPermissions,'registerPendingPermission'|'resolvePermission'|'pendingPermissionCodeOf'>, ownerChatId: () => string | null): NonNullable<ServiceDeps['permissionPrompt']> {
  return (title, permission, answer, deadline) => {
    const chatId = ownerChatId(); if (!chatId) return () => {}
    let closed=false
    // Delivery remains in workbench notices: App and WeChat share one speech event.
    void registry.registerPendingPermission(permission.id, WORKBENCH_PERMISSION_TIMEOUT_MS, {
      chatId,prompt:`${title} · ${permission.taskId}\n${permission.tool}\n${permission.description}`,taskId:permission.taskId,
      ...(permission.canAllowTask?{canAllowTask:true}:{}),...(permission.scripts?{scripts:permission.scripts}:{}),
    },{
      deadline,
      ...(permission.canAllowTask ? { onAllowTask: () => answer('allow_task') } : {}),
    }).then(d => { if (!closed) answer(d === 'allow' ? 'allow' : 'deny') }).catch(() => {})
    const code=registry.pendingPermissionCodeOf(permission.id)
    const replyLine=code?`回「y ${code}」允许这一步、「n ${code}」拒绝。${permission.canAllowTask?`回「yt ${code}」本任务同命令都允许，任务结束失效。`:''}`:''
    return Object.assign(()=>{closed=true;registry.resolvePermission(permission.id,'deny')},{replyLine})
  }
}
