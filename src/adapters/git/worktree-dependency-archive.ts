import * as fs from 'node:fs/promises'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { DependencyPathNamespace, dependencyPathIdentity, dependencySafePart } from './worktree-dependency-policy'
import type { Preparation } from './worktree-preparation'
import type { DependencyOptions } from './worktree-dependencies'

/** Counters are charged BEFORE mkdir/open/write, shared by every package. */
export class InstallQuota {
  bytes = 0
  entries = 0
  downloaded = 0
  readonly maxBytes: number
  readonly maxEntries: number
  constructor(readonly root: string, readonly budget: Preparation, readonly options: DependencyOptions, limit: number) {
    this.maxBytes = Math.min(options.maxBytes ?? 1024 ** 3, Math.floor(limit / 2))
    this.maxEntries = Math.floor((options.maxEntries ?? 100_000) / 2)
  }
  async room(bytes = 0) {
    this.budget.check()
    const disk = await fs.statfs(this.root)
    if (Number(disk.bavail) * Number(disk.bsize) < bytes + (this.options.minFreeBytes ?? 64 * 1024 ** 2)) throw Error('dependency_space_budget')
  }
  preflight(bytes: number, entries: number) {
    this.budget.check()
    if (bytes > this.maxBytes - this.bytes) throw Error('dependency_copy_budget')
    if (entries > this.maxEntries - this.entries) throw Error('dependency_entry_budget')
  }
  async directory(path: string) {
    const rel = relative(this.root, path)
    if (isAbsolute(rel) || rel.split(sep).includes('..')) throw Error('dependency_archive_path')
    let cursor = this.root
    for (const part of rel.split(sep).filter(Boolean)) {
      if (!dependencySafePart(part)) throw Error('dependency_archive_path')
      cursor = join(cursor, part)
      const current = await fs.lstat(cursor).catch(e => { if (e.code === 'ENOENT') return null; throw e })
      if (current) { if (!current.isDirectory() || current.isSymbolicLink()) throw Error('dependency_archive_path'); continue }
      this.preflight(0, 1); await this.room(); this.entries++
      await fs.mkdir(cursor, { mode: 0o700 })
    }
  }
  async file(path: string, data: Buffer, executable: boolean) {
    if (!dependencySafePart(relative(this.root, path).split(sep).at(-1)!)) throw Error('dependency_archive_path')
    this.preflight(data.length, 1)
    await this.directory(dirname(path))
    this.preflight(0, 1); this.entries++
    await this.room()
    const handle = await fs.open(path, 'wx', executable ? 0o700 : 0o600)
    try {
      for (let offset = 0; offset < data.length;) {
        const length = Math.min(64 * 1024, data.length - offset)
        this.preflight(length, 0); await this.room(length); this.bytes += length
        const { bytesWritten } = await handle.write(data, offset, length, null)
        if (!bytesWritten) throw Error('dependency_write_failed')
        offset += bytesWritten
      }
    } finally { await handle.close() }
  }
}
/** Strict ustar subset. PAX, sparse files, links and special types safely miss. */
export async function extractPackage(archive: Buffer, root: string, quota: InstallQuota): Promise<void> {
  const gunzip = createGunzip({ chunkSize: 64 * 1024 })
  const input = Readable.from([archive]); input.pipe(gunzip)
  const chunks: Buffer[] = []; let expanded = 0
  try {
    for await (const chunk of gunzip) {
      quota.budget.check(); expanded += chunk.length
      if (expanded > Math.min(quota.maxBytes - quota.bytes + quota.maxEntries * 1024, 128 * 1024 ** 2)) throw Error('dependency_expansion_budget')
      chunks.push(chunk)
    }
  } finally { input.destroy(); gunzip.destroy() }
  const tar = Buffer.concat(chunks), files: { path: string; data: Buffer; executable: boolean }[] = []
  let offset = 0, bytes = 0, entries = 0, ended = false
  const namespace = new DependencyPathNamespace()
  const string = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '')
  const pathString = (b: Buffer) => {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0))) }
    catch { throw Error('dependency_archive_path') }
  }
  const octal = (b: Buffer) => { const s = string(b).trim(); if (!/^[0-7]+$/.test(s)) throw Error('dependency_archive_header'); return parseInt(s, 8) }
  while (offset + 512 <= tar.length) {
    quota.budget.check()
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every(b => b === 0)) { ended = true; break }
    const expected = octal(header.subarray(148, 156))
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    if (expected !== sum) throw Error('dependency_archive_checksum')
    const prefix = pathString(header.subarray(345, 500)), name = (prefix ? prefix + '/' : '') + pathString(header.subarray(0, 100))
    const path = name.replace(/\/$/, '')
    if (!path.startsWith('package/') && path !== 'package') throw Error('dependency_archive_path')
    const relative = path.slice(8)
    if (relative && relative.split('/').some(p => dependencyPathIdentity(p) === 'NODE_MODULES')) throw Error('dependency_archive_path')
    const size = octal(header.subarray(124, 136)), type = header[156]
    if (!Number.isSafeInteger(size) || offset + size > tar.length || ![0,48,53].includes(type!)) throw Error('dependency_archive_type')
    entries += 1 + (relative.match(/\//g)?.length ?? 0)
    bytes += size; quota.preflight(bytes, entries)
    if (type === 53 && size !== 0) throw Error('dependency_archive_header')
    if (type !== 53 && !relative) throw Error('dependency_archive_path')
    namespace.add(relative, type === 53)
    if (type !== 53) {
      files.push({ path: join(root, relative), data: tar.subarray(offset, offset + size), executable: !!(octal(header.subarray(100,108)) & 0o111) })
    }
    offset += Math.ceil(size / 512) * 512
  }
  if (!ended || tar.subarray(offset).some(b => b !== 0)) throw Error('dependency_archive_truncated')
  await quota.directory(root)
  for (const file of files) {
    await quota.file(file.path, file.data, file.executable)
  }
}
