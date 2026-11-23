import type { WechatPermissions } from '../../ports/wechat'
import type { PermissionPromptContext, ServiceDeps } from './service/ctx'
import { WORKBENCH_PERMISSION_TIMEOUT_MS } from '../../adapters/workbench/permissions'
import { permissionCwd } from '@wechat-cc/protocol'
import {
  normalizePermissionLines, permissionActionZh, permissionLines, permissionPatchLabel,
  permissionRelativePath, resolvePermissionDisplay,
} from '../../../packages/protocol/src/permission-presentation'
import type { PendingWorkbenchPermission } from '../../ports/workbench'

export const REQUEST_MAX = 6000
export const PERMISSION_TOO_LONG = '权限内容较长，请在桌面工作台完整查看。'

const DIFF_LINES = 6
function diffPreview(lines: string[]) {
  const hidden = lines.length - DIFF_LINES
  return [...lines.slice(0, DIFF_LINES), ...(hidden > 0 ? [`…（还有 ${hidden} 行，到电脑或手机上看全部）`] : [])]
}

export function formatWorkbenchPermission(
  title: string, permission: PendingWorkbenchPermission, context?: PermissionPromptContext, limit = REQUEST_MAX,
): string | undefined {
  const { tool, description } = permission
  const display = resolvePermissionDisplay(tool, description, permission.display, context?.executor ?? '')
  const { body } = display
  const actor = context?.actor || '执行助手'
  const who = `${actor} 想`
  const cwd = permissionCwd(permission.cwd)
  const path = (value: string) => permissionRelativePath(value, cwd ?? context?.projectPath ?? '')
  const fields = (values: NonNullable<typeof display.extra>) => values.map(({ name, value }) => `${name}：${value}`)
  let action = permissionActionZh(body, tool, actor)
  let content: string[]
  switch (body.kind) {
    case 'command': content = [`$ ${body.command}`]; break
    case 'edit':
      action = `${who}改 ${path(body.path)}（${body.changes.length} 处）${body.replaceAll ? '（全部替换）' : ''}`
      content = body.changes.flatMap(({ path: changePath, before, after }) => [
        ...(changePath && changePath !== body.path ? [path(changePath)] : []),
        ...diffPreview([...permissionLines(before).map(line => `- ${line}`), ...permissionLines(after).map(line => `+ ${line}`)]),
      ])
      break
    case 'write':
      action = `${who}写 ${path(body.path)}`
      content = diffPreview(permissionLines(body.content).map(line => `+ ${line}`))
      break
    case 'patch':
      content = body.files.map(file => `${path(file.path)}（${permissionPatchLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath))}）`)
      break
    case 'url': content = [body.url, ...(body.prompt ? [body.prompt] : [])]; break
    case 'query': content = [`“${body.query}”`]; break
    case 'fields': content = fields(body.fields); break
    case 'text': content = [body.text]; break
  }

  const header = permissionPromptHeader(title, permission.taskId)
  const message = normalizePermissionLines([
    header, `${action}：`, ...content, ...fields(display.extra ?? []),
    ...(cwd ? [`在 ${cwd}`] : []),
    ...(display.truncated ? ['这里可能不是全部内容。'] : []),
  ].join('\n'))
  return message.length <= limit ? message : undefined
}

function permissionPromptHeader(title: string, taskId: string) {
  return `${normalizePermissionLines(title).replace(/\n+/g, ' ')} · ${taskId}`
}

/** One pending card shared by WeChat codes and the desktop pet; a settlement on
 * any workbench surface removes the code through the returned disposer. */
export function makeWorkbenchPermissionPrompt(registry: Pick<WechatPermissions,'registerPendingPermission'|'resolvePermission'|'pendingPermissionCodeOf'>, ownerChatId: () => string | null): NonNullable<ServiceDeps['permissionPrompt']> {
  return (title, permission, answer, deadline, context) => {
    const chatId = ownerChatId(); if (!chatId) return () => {}
    let closed=false
    const header = permissionPromptHeader(title, permission.taskId)
    const prompt = formatWorkbenchPermission(title, permission, context)
      ?? (header.length + 1 + PERMISSION_TOO_LONG.length <= REQUEST_MAX ? `${header}\n${PERMISSION_TOO_LONG}` : PERMISSION_TOO_LONG)
    // Delivery remains in workbench notices: App and WeChat share one speech event.
    void registry.registerPendingPermission(permission.id, WORKBENCH_PERMISSION_TIMEOUT_MS, {
      chatId,prompt,taskId:permission.taskId,
      ...(permission.canAllowTask?{canAllowTask:true}:{}),...(permission.scripts?{scripts:permission.scripts}:{}),
      ...(permission.canDenyWithReason?{canDenyWithReason:true}:{}),
    },{
      deadline,
      onDecision: (decision,reason) => closed ? decision === 'deny' : reason ? answer(decision,reason) : answer(decision),
    }).catch(() => {}) // Explicit decisions run through onDecision; expiry is not an owner rejection.
    const code=registry.pendingPermissionCodeOf(permission.id)
    const replyLine=code?`回「y ${code}」允许这一步、「n ${code}」拒绝。${permission.canDenyWithReason?`拒绝理由选填：「n ${code} 理由」。`:''}${permission.canAllowTask?`回「yt ${code}」本任务同命令都允许，任务结束失效。`:''}`:''
    return Object.assign(()=>{closed=true;registry.resolvePermission(permission.id,'deny')},{replyLine})
  }
}
