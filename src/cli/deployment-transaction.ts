import { realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import z from 'zod'
import { writeJsonAtomic } from '../lib/json-file'
import { readJsonFile } from '../lib/read-json-file'
import { openSqlite } from '../lib/runtime/sqlite'

export const DEPLOYMENT_BUSY = '另一条部署正在持锁。'

export interface DeploymentLock {
  holds(path: string): boolean
  release(): void
}

// 同一用户的部署入口共用 LaunchAgent，即使 --app 或状态目录不同。
export const deploymentLockPath = (homeDir: string) => join(homeDir, '.wechat-cc-self-deploy.lock.sqlite')

export function acquireDeploymentLock(homeDir: string) {
  return acquireDeploymentLockAt(deploymentLockPath(homeDir))
}

export function acquireDeploymentLockAt(path: string): DeploymentLock | { busy: true } {
  const db = openSqlite(path, { create: true })
  try {
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    const { code, errno, errcode } = err as { code?: string; errno?: number; errcode?: number }
    if (code === 'SQLITE_BUSY' || errno === 5 || errcode === 5) return { busy: true }
    throw err
  }
  let held = true
  return {
    holds: requested => held && requested === path,
    release() {
      if (!held) return
      held = false
      // 关闭连接隐式回滚。保留文件及 inode，SIGKILL 后 SQLite 的锁也由系统释放。
      db.close()
    },
  }
}

export function canonicalDeploymentPath(path: string): string {
  return resolve(realpathSync(dirname(path)), basename(path))
}

export function sameDeploymentPath(a: string, b: string): boolean {
  try { return canonicalDeploymentPath(a) === canonicalDeploymentPath(b) } catch { return false }
}

const transactionShape = z.object({
  sha: z.string().optional(),
  targetVersion: z.string().optional(),
  previousVersion: z.string().min(1),
  sidecarPath: z.string().optional(),
  backupPath: z.string().min(1),
  startedAt: z.string().min(1),
})

type Transaction = z.infer<typeof transactionShape>
type Pending = { message: string; transaction?: Transaction }

export function deploymentTransactions(lockPath: string, stateDir: string) {
  const path = lockPath + '.transaction.json'
  const legacy = join(stateDir, 'self-change', 'autoship-transaction.json')
  const recovery = '请核对安装和备份，必要时用 self deploy --binary 指定记录中的备份回滚，确认处理后运行 self autoship --unhalt。'
  function read(file: string): Pending | null {
    try {
      const transaction = transactionShape.parse(readJsonFile(file))
      const { sha, targetVersion, startedAt, previousVersion, backupPath } = transaction
      return { transaction, message: `发现未完成的部署事务 ${sha ?? targetVersion ?? '版本未知'}（${startedAt}）。上一版 ${previousVersion}，备份 ${backupPath}。${recovery}` }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { message: `部署事务记录无法读取（${file}）。请核对安装和备份后运行 self autoship --unhalt。` }
    }
  }
  return {
    pending() {
      const current = read(path)
      const old = read(legacy)
      if (current && old) return { message: `${current.message}\n${old.message}` }
      return current ?? old
    },
    begin: (transaction: Transaction) => writeJsonAtomic(path, transaction, { mode: 0o600 }),
    finish: () => rmSync(path, { force: true }),
    confirm() {
      rmSync(legacy, { force: true })
      rmSync(path, { force: true })
    },
  }
}
