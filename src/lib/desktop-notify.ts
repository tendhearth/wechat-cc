/**
 * desktop-notify.ts — 人在电脑前时的通知面:系统原生通知,不进微信。
 * 发不出去就算了(记日志),它不是必达通道 —— 人就在屏幕前,终端本身就在眼前。
 */
import { execFile } from 'node:child_process'

export type NotifyExec = (cmd: string, args: string[]) => Promise<void>

const defaultExec: NotifyExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err) => err ? reject(err) : resolve())
})

/** AppleScript 字符串里只有反斜杠和双引号要转义。 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''")
}

export async function notifyDesktop(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  exec: NotifyExec = defaultExec,
): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      await exec('osascript', ['-e', `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`])
      return true
    }
    if (platform === 'linux') {
      await exec('notify-send', [title, body])
      return true
    }
    if (platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        `$n.ShowBalloonTip(8000, '${escapePowerShell(title)}', '${escapePowerShell(body)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
        'Start-Sleep -Milliseconds 500',
      ].join('; ')
      await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
      return true
    }
    return false
  } catch {
    return false
  }
}
