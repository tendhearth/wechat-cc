const prefix = '待批 / Approval · '

export function wechatPermissionHeader(title: string, taskId: string): string {
  return `${prefix}${title ? `${title} · ` : ''}${taskId}`
}

export function hasWechatPermissionHeader(line: string): boolean {
  return line.startsWith(prefix)
}
