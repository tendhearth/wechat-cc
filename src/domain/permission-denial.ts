/** Shared by approval entry points; never silently truncate the owner's input. */
export const PERMISSION_REASON_MAX = 2000
export function permissionReason(value: unknown, decision: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > PERMISSION_REASON_MAX || (decision !== 'deny' && value.trim())) throw Error('invalid_request')
  return value.trim() || undefined
}

export function permissionDenialMessage(operation: string, reason: string): string {
  return `这个操作被拒绝了：\n${operation}\n\n拒绝理由：${reason || '未填写'}\n\n请遵守这次拒绝，换一种获准的做法继续原任务。不要原样重试被拒绝的操作，也不要扩大权限；确实无法继续时说明缺项并等待主人。`
}
