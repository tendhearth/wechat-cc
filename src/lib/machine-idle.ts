/**
 * machine-idle.ts — 「这台电脑有没有人在用」:上次键鼠输入距今多少秒。
 *
 * 在场判断的主信号(spec 2026-09-09-cli-hook-push §5 补):人在电脑前,通知落桌面;
 * 机器空闲够久,才走微信。三平台各一条命令,探不到就 null(调用方回落到
 * 「这条会话最近敲没敲字」)。
 */
import { execFile } from 'node:child_process'

export type ExecProbe = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

const defaultExec: ExecProbe = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
    if (err) reject(err); else resolve(String(stdout))
  })
})

/** macOS `ioreg -c IOHIDSystem -d 4` 里的 HIDIdleTime 是纳秒。 */
export function parseIoregIdle(out: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)
  if (!m) return null
  return Number(m[1]) / 1e9
}

/** Windows / Linux 探针都打印毫秒。 */
export function parseMillis(out: string): number | null {
  const m = /(\d+)/.exec(out.trim())
  if (!m) return null
  return Number(m[1]) / 1000
}

const WIN_SCRIPT = [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public class LI { [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  'public static uint Idle() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; } }',
  '"@',
  '[LI]::Idle()',
].join('\n')

export async function machineIdleSeconds(
  platform: NodeJS.Platform = process.platform,
  exec: ExecProbe = defaultExec,
  timeoutMs = 1500,
): Promise<number | null> {
  try {
    if (platform === 'darwin') return parseIoregIdle(await exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], timeoutMs))
    if (platform === 'win32') return parseMillis(await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], timeoutMs))
    if (platform === 'linux') return parseMillis(await exec('xprintidle', [], timeoutMs))
    return null
  } catch {
    return null
  }
}
