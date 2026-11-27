import { createHash } from 'node:crypto'
import * as nativeFs from 'node:fs/promises'
import { join } from 'node:path'

const filename = 'macmini-lab-bootstrap.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const versionOf = bytes => /^export const BOOTSTRAP_VERSION = (\d+)$/m.exec(bytes.toString())?.[1] ?? 'unknown'

export async function installBootstrap({ home, labHome, bootstrap, lockSource, lock,
  fs = nativeFs, log = console.log }) {
  const lab = await fs.realpath(labHome)
  const target = join(lab, filename)
  const sha256 = digest(bootstrap)
  const release = await lock(home, 'lab-install', sha256, lockSource)
  try {
    const readExisting = async path => {
      const stat = await fs.lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (!stat) return undefined
      if (!stat.isFile() || await fs.realpath(path) !== path) throw Error('Unsafe bootstrap path: ' + path)
      return fs.readFile(path)
    }
    const previous = await readExisting(target)
    const previousHash = previous && digest(previous)
    const backup = previousHash && previousHash !== sha256 ? target + '.previous-' + previousHash : undefined
    log(JSON.stringify({ path: target, previous: previous ? { version: versionOf(previous), sha256: previousHash } : null,
      next: { version: versionOf(bootstrap), sha256 }, backup }))
    if (previousHash === sha256) return
    const stage = await fs.mkdtemp(join(lab, '.bootstrap-'))
    try {
      if (backup) {
        const saved = await readExisting(backup)
        if (saved && !saved.equals(previous)) throw Error('Bootstrap backup content mismatch')
        if (!saved) {
          const stagedBackup = join(stage, 'previous')
          await fs.writeFile(stagedBackup, previous, { mode: 0o444, flag: 'wx' })
          await fs.rename(stagedBackup, backup)
        }
      }
      const next = join(stage, filename)
      await fs.writeFile(next, bootstrap, { mode: 0o444, flag: 'wx' })
      await fs.rename(next, target)
    } finally { await fs.rm(stage, { recursive: true, force: true }) }
  } finally { await release() }
}

export async function installFromStdin(input = process.stdin) {
  const chunks = []
  let size = 0
  for await (const chunk of input) {
    size += chunk.length
    if (size > 128 * 1024) throw Error('Bootstrap install request exceeds limit')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks))
  const bootstrap = Buffer.from(payload.bootstrap, 'base64')
  if (digest(bootstrap) !== payload.sha256) throw Error('Bootstrap SHA-256 mismatch')
  const { sshLab, familyLock } = await import('data:text/javascript;base64,' + bootstrap.toString('base64'))
  await installBootstrap({ ...sshLab(), bootstrap, lockSource: Buffer.from(payload.lock, 'base64'), lock: familyLock })
}
