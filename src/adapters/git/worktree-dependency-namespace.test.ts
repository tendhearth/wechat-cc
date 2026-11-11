import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installDependencies } from './worktree-dependency-installer'
import { dependencyInstallPlan, dependencySafePart } from './worktree-dependency-policy'
import { Preparation } from './worktree-preparation'
import { InstallQuota, extractPackage } from './worktree-dependency-archive'
import { removeTempDir } from '../../lib/test-temp'

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(removeTempDir) })

type Entry = { name: string | Buffer; data?: string; type?: string }
function archive(entries: Entry[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? ''), h = Buffer.alloc(512)
    Buffer.from(entry.name).copy(h); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136)
    h.fill(32, 148, 156); h.write(entry.type ?? '0', 156); h.write('ustar\0', 257)
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-archive-namespace-'))); roots.push(base)
  const budget = new Preparation(), quota = new InstallQuota(base, budget, {}, 1_000_000)
  return { base, root: join(base, 'pkg'), budget, quota }
}

// Third review's seven red fixtures: two directory aliases, the full installer,
// and four reserved device aliases. All rejection happens before package writes.
it.each([
  ['case', ['package/A/x', 'package/a/y']],
  ['Unicode', ['package/é/x', 'package/e\u0301/y']],
])('review rejects %s-equivalent parent directories before writing', async (_kind, names) => {
  const f = fixture()
  await expect(extractPackage(archive(names.map(name => ({ name, data: 'marker' }))), f.root, f.quota)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(f.root)).toBe(false)
})
it('review rejects NODE_MODULES in a package even without bundled manifest fields', async () => {
  const f = fixture(), data = archive([
    { name: 'package/package.json', data: JSON.stringify({ name: 'tool', version: '1.0.0' }) },
    { name: 'package/index.js', data: '' },
    { name: 'package/NODE_MODULES/ghost/index.js', data: 'marker' },
  ])
  const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64')
  const files = new Map([['package.json', Buffer.from('{}')], ['bun.lock', Buffer.from(JSON.stringify({ lockfileVersion: 1, packages: { tool: ['tool@1.0.0', '', {}, integrity] } }))]])
  for (const key of Object.keys(process.env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) vi.stubEnv(key, '')
  network.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  network.request.mockReset().mockImplementation((_url, _opts, callback) => {
    const req = new EventEmitter() as any
    req.destroy = vi.fn(); req.end = () => {
      const res = new PassThrough() as any; res.statusCode = 200; res.headers = {}
      callback(res); res.end(data)
    }
    return req
  })
  await expect(installDependencies(f.base, f.budget, files)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(join(f.base, 'node_modules/tool'))).toBe(false)
})
it.each(['COM¹', 'LPT².txt', 'CONIN$', 'CONOUT$'])('review rejects portable reserved device alias %s', name => {
  expect(dependencySafePart(name)).toBe(false)
})

it.each([
  ['file case', [{ name: 'package/A' }, { name: 'package/a' }]],
  ['file Unicode', [{ name: 'package/é' }, { name: 'package/e\u0301' }]],
  ['deep alias', [{ name: 'package/top/A/x' }, { name: 'package/top/a/y' }]],
  ['declared directory alias', [{ name: 'package/A/', type: '5' }, { name: 'package/a/', type: '5' }]],
  ['declared then file', [{ name: 'package/a/', type: '5' }, { name: 'package/a' }]],
  ['file then declared', [{ name: 'package/a' }, { name: 'package/a/', type: '5' }]],
  ['implicit then file', [{ name: 'package/a/x' }, { name: 'package/a' }]],
  ['file then implicit', [{ name: 'package/a' }, { name: 'package/a/x' }]],
  ['duplicate file', [{ name: 'package/a' }, { name: 'package/a' }]],
  ['duplicate directory', [{ name: 'package/a/', type: '5' }, { name: 'package/a/', type: '5' }]],
  ['duplicate root', [{ name: 'package/', type: '5' }, { name: 'package/', type: '5' }]],
  ['sharp s', [{ name: 'package/Straße/x' }, { name: 'package/STRASSE/y' }]],
  ['capital sharp s', [{ name: 'package/ẞ/x' }, { name: 'package/ss/y' }]],
  ['Greek sigma', [{ name: 'package/σ/x' }, { name: 'package/ς/y' }]],
  ['Greek final sigma context', [{ name: 'package/ΟΣ/x' }, { name: 'package/οσ/y' }]],
  ['ligature', [{ name: 'package/ﬀ/x' }, { name: 'package/ff/y' }]],
  ['canonical reorder', [{ name: 'package/a\u0301\u0323/x' }, { name: 'package/a\u0323\u0301/y' }]],
])('rejects %s collisions before writing even the first valid file', async (_kind, entries) => {
  const f = fixture()
  await expect(extractPackage(archive([{ name: 'package/valid', data: 'first' }, ...entries]), f.root, f.quota)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(f.root)).toBe(false)
  expect(f.quota.entries).toBe(0)
})
it.each([
  'COM¹', 'cOm².txt', 'LPT³', 'conin$.txt', 'CONOUT$', 'NUL .txt',
  'node_modules.', 'NODE_MODULES ', 'dir./file', 'dir /file', 'file:stream',
  '.GiT/config', 'NODE_MODULES/ghost/index.js', 'top/Node_Modules/x',
  'bad?name', 'bad*name', 'bad|name', 'bad<name', 'bad>name', 'bad"name',
  'node_\u200cmodules/x', 'A\u200d/file', 'A\ufeff/file',
  'LONGDI~1/file',
])('rejects forbidden normalized components before writing: %s', async name => {
  const f = fixture()
  await expect(extractPackage(archive([{ name: 'package/valid' }, { name: 'package/' + name }]), f.root, f.quota)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(f.root)).toBe(false)
})
it.each(['é', 'e\u0301'])('allows consistent %s spelling, shared parents and later explicit declarations', async spelling => {
  const f = fixture()
  await extractPackage(archive([
    { name: 'package/', type: '5' },
    { name: `package/${spelling}/first`, data: 'one' },
    { name: `package/${spelling}/`, type: '5' },
    { name: `package/${spelling}/second`, data: 'two' },
    { name: 'package/another/FIRST', data: 'three' },
  ]), f.root, f.quota)
  expect(await readFile(join(f.root, spelling, 'first'), 'utf8')).toBe('one')
  expect(await readFile(join(f.root, spelling, 'second'), 'utf8')).toBe('two')
  expect(await readFile(join(f.root, 'another/FIRST'), 'utf8')).toBe('three')
  expect(await readdir(join(f.root, spelling))).toHaveLength(2)
})
it('rejects malformed UTF-8 instead of merging names decoded with replacement characters', async () => {
  const f = fixture()
  const entries = [0xff, 0xfe].map((byte, i) => ({ name: Buffer.concat([Buffer.from('package/A'), Buffer.from([byte]), Buffer.from('/' + i)]) }))
  await expect(extractPackage(archive(entries), f.root, f.quota)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(f.root)).toBe(false)
})
it.each([
  ['Tool', 'tool'],
  ['@Scope/first', '@scope/second'],
])('rejects aliased installation parents %s / %s before downloading', (first, second) => {
  const tuple = ['tool@1.0.0', '', {}, 'sha512-' + 'A'.repeat(86) + '==']
  const files = new Map([['package.json', Buffer.from('{}')], ['bun.lock', Buffer.from(JSON.stringify({ lockfileVersion: 1, packages: { [first]: tuple, [second]: tuple } }))]])
  expect(() => dependencyInstallPlan(files)).toThrow('dependency_lock_layout')
})
