/**
 * daemon.env —— provider API key 的「重启也还在」的家(lib/env-file.ts)。开机之前读,provider 注册才看得到这些 key;
 * 真环境变量永远优先于文件。日志里只写名字。(从 main.ts 抽出来,2026-10-26。)
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { log } from '../../lib/log'

export async function loadDaemonEnv(stateDir: string): Promise<void> {
  try {
    const envPath = join(stateDir, 'daemon.env')
    if (existsSync(envPath)) {
      const { parseEnvFile } = await import('../../lib/env-file')
      const fileEnv = parseEnvFile(readFileSync(envPath, 'utf8'))
      const applied = Object.keys(fileEnv).filter(k => process.env[k] === undefined)
      for (const k of applied) process.env[k] = fileEnv[k]!
      if (applied.length > 0) log('DAEMON', `daemon.env loaded: ${applied.join(', ')}`)
    }
  } catch (err) { log('DAEMON', `daemon.env load failed (continuing): ${err instanceof Error ? err.message : err}`) }
}
