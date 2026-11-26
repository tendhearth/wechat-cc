const prefix = '待批 / Approval · '

export function wechatPermissionHeader(title: string, taskId: string): string {
  return `${prefix}${title ? `${title} · ` : ''}${taskId}`
}

export function hasWechatPermissionHeader(line: string): boolean {
  return line.startsWith(prefix)
}

export const WECHAT_PERMISSION_INCOMPLETE = '内容在微信里看不全，请到电脑或手机上看全再定。'
