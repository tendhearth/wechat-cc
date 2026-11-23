import type { WechatPermissions } from '../../ports/wechat'
import type { PermissionPromptContext, ServiceDeps } from './service/ctx'
import { WORKBENCH_PERMISSION_TIMEOUT_MS } from '../../adapters/workbench/permissions'
import { PERMISSION_SNAPSHOT_NOTICE, permissionCwd } from '@wechat-cc/protocol'
import {
  normalizePermissionLines, permissionActionZh, permissionEditPreview, permissionLines, permissionPatchLabel,
  PERMISSION_NO_FINAL_NEWLINE_ZH, PERMISSION_WHITESPACE_NOTICE_ZH,
  permissionRelativePath, resolvePermissionDisplay,
} from '../../../packages/protocol/src/permission-presentation'
import type { PendingWorkbenchPermission } from '../../ports/workbench'

export const REQUEST_MAX = 6000
const PERMISSION_TOO_LONG = '权限内容较长，请在桌面工作台完整查看。'
const PERMISSION_APPROVAL_TOO_LONG = '这项权限内容较长，请在桌面工作台完整查看后处理。微信仍可拒绝。'
const PERMISSION_APPROVAL_INCOMPLETE = '这项权限的完整内容请在桌面工作台查看。微信仍可拒绝。'

const DIFF_LINES = 6
function renderWorkbenchPermission(title: string, permission: PendingWorkbenchPermission, context?: PermissionPromptContext) {
  const { tool, description } = permission
  const display = resolvePermissionDisplay(tool, description, permission.display, context?.executor ?? '')
  const { body } = display
  const actor = context?.actor || '执行助手'
  const who = `${actor} 想`
  const cwd = permissionCwd(permission.cwd)
  const path = (value: string) => permissionRelativePath(value, cwd ?? '')
  let complete = display.truncated !== true && !permission.scripts?.length
  let whitespaceChange = false
  function diffPreview(lines: string[]) {
    const hidden = lines.length - DIFF_LINES
    if (hidden <= 0) return lines
    complete = false
    return [...lines.slice(0, DIFF_LINES), `…（还有 ${hidden} 行，到电脑或手机上看全部）`]
  }
  const fields = (values: NonNullable<typeof display.extra>) => values.map(({ name, value }) => `${name}：${value}`)
  let action = permissionActionZh(body, tool, actor)
  let content: string[]
  switch (body.kind) {
    case 'command': content = [`$ ${body.command}`]; break
    case 'edit':
      action = `${who}改 ${path(body.path)}（${body.changes.length} 处）${body.replaceAll ? '（全部替换）' : ''}`
      content = body.changes.flatMap(({ path: changePath, before, after }) => {
        const edit = permissionEditPreview(before, after)
        whitespaceChange ||= edit.whitespaceChange
        const lines = [
          ...edit.before.map(line => `- ${line}`),
          ...(edit.noFinalNewline === 'before' ? [PERMISSION_NO_FINAL_NEWLINE_ZH] : []),
          ...edit.after.map(line => `+ ${line}`),
          ...(edit.noFinalNewline === 'after' ? [PERMISSION_NO_FINAL_NEWLINE_ZH] : []),
        ]
        const markerHidden = lines.indexOf(PERMISSION_NO_FINAL_NEWLINE_ZH) >= DIFF_LINES
        return [
          ...(changePath && changePath !== body.path ? [path(changePath)] : []),
          ...diffPreview(lines),
          ...(markerHidden ? [`${edit.noFinalNewline === 'before' ? '修改前' : '修改后'}${PERMISSION_NO_FINAL_NEWLINE_ZH}`] : []),
          ...(edit.whitespaceChange ? [PERMISSION_WHITESPACE_NOTICE_ZH] : []),
        ]
      })
      break
    case 'write':
      action = `${who}写 ${path(body.path)}`
      content = diffPreview(permissionLines(body.content).map(line => `+ ${line}`))
      break
    case 'patch':
      if (body.files.some(file => file.diff)) complete = false
      content = body.files.map(file => `${path(file.path)}（${permissionPatchLabel(file.change, file.movePath === undefined ? undefined : path(file.movePath))}）`)
      break
    case 'url': content = [body.url, ...(body.prompt ? [body.prompt] : [])]; break
    case 'query': content = [`“${body.query}”`]; break
    case 'fields': content = fields(body.fields); break
    case 'text': content = [body.text]; break
  }

  const header = permissionPromptHeader(title, permission.taskId)
  const text = normalizePermissionLines([
    header, `${action}：`, ...(display.note ? [display.note] : []), ...content, ...fields(display.extra ?? []),
    ...(cwd ? [`在 ${cwd}`] : []),
    ...(display.truncated ? ['这里可能不是全部内容。'] : []),
  ].join('\n'))
  const message = permission.showSnapshotNotice && !text.includes(PERMISSION_SNAPSHOT_NOTICE)
    ? `${text}\n${PERMISSION_SNAPSHOT_NOTICE}` : text
  return { message, complete: complete && !whitespaceChange, whitespaceChange }
}

/** The review and both WeChat approval entry points use the same message budget. */
export function wechatPermissionReview(title: string, permission: PendingWorkbenchPermission, context?: PermissionPromptContext) {
  const { taskId, id } = permission
  const allow = `允许：任务 ${taskId} 允许 ${id}`
  const deny = `拒绝：任务 ${taskId} 拒绝 ${id}`
  const controls = `\n\n${allow}\n${deny}`
  const notice = permission.showSnapshotNotice ? `\n${PERMISSION_SNAPSHOT_NOTICE}` : ''
  const fallback = `任务 ${taskId}：${PERMISSION_TOO_LONG}${notice}\n可${deny}`
  if (permission.description.length > REQUEST_MAX) return { reply: fallback, blocked: PERMISSION_APPROVAL_TOO_LONG }
  const { message, complete, whitespaceChange } = renderWorkbenchPermission(title, permission, context)
  if (message.length + controls.length > REQUEST_MAX) return { reply: fallback, blocked: PERMISSION_APPROVAL_TOO_LONG }
  if (complete) return { reply: message + controls }
  const reply = `${message}\n\n${PERMISSION_APPROVAL_INCOMPLETE}\n${deny}`
  const blocked = whitespaceChange ? `${PERMISSION_WHITESPACE_NOTICE_ZH}${PERMISSION_APPROVAL_INCOMPLETE}` : PERMISSION_APPROVAL_INCOMPLETE
  return { reply: reply.length <= REQUEST_MAX ? reply : fallback, blocked }
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
    const prompt = `${permissionPromptHeader(title, permission.taskId)}\n${permission.tool}\n${permission.description}`
    const review = wechatPermissionReview(title, permission, context)
    // Delivery remains in workbench notices: App and WeChat share one speech event.
    void registry.registerPendingPermission(permission.id, WORKBENCH_PERMISSION_TIMEOUT_MS, {
      chatId,prompt,taskId:permission.taskId,
      ...(review.blocked ? { wechatApprovalBlock: review.blocked } : {}),
      ...(permission.canAllowTask?{canAllowTask:true}:{}),...(permission.scripts?{scripts:permission.scripts}:{}),
      ...(permission.canDenyWithReason?{canDenyWithReason:true}:{}),
    },{
      deadline,
      onDecision: (decision,reason) => closed ? decision === 'deny' : reason ? answer(decision,reason) : answer(decision),
    }).catch(() => {}) // Explicit decisions run through onDecision; expiry is not an owner rejection.
    const code=registry.pendingPermissionCodeOf(permission.id)
    const denialReason = code && permission.canDenyWithReason ? `拒绝理由选填：「n ${code} 理由」。` : ''
    const replyLine = !code ? '' : review.blocked
      ? `${review.blocked}回「n ${code}」拒绝。${denialReason}`
      : `回「y ${code}」允许这一步、「n ${code}」拒绝。${denialReason}${permission.canAllowTask ? `回「yt ${code}」本任务同命令都允许，任务结束失效。` : ''}`
    return Object.assign(()=>{closed=true;registry.resolvePermission(permission.id,'deny')},{replyLine})
  }
}
