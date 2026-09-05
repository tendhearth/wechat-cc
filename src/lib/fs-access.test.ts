import { describe, it, expect } from 'vitest'
import { probeFsAccess, classifyFsError, describeFsAccess } from './fs-access'

const err = (code: string) => Object.assign(new Error(code), { code })

describe('probeFsAccess —— daemon 自己能不能读主人的文件夹', () => {
  it('EPERM = TCC 拒绝 → denied,anyDenied 为真,给出系统设置 deep link', () => {
    const r = probeFsAccess({ home: '/Users/x', platform: 'darwin', readdir: (p) => { if (p.endsWith('Documents')) throw err('EPERM'); return [] } })
    expect(r.folders.find(f => f.folder === 'documents')!.state).toBe('denied')
    expect(r.folders.find(f => f.folder === 'desktop')!.state).toBe('ok')
    expect(r.anyDenied).toBe(true)
    expect(r.settingsUrl).toContain('Privacy_AllFiles')
  })
  it('目录不存在 ≠ 没权限(Linux 上常没有 ~/Desktop)', () => {
    const r = probeFsAccess({ home: '/h', platform: 'linux', readdir: () => { throw err('ENOENT') } })
    expect(r.folders.every(f => f.state === 'missing')).toBe(true)
    expect(r.anyDenied).toBe(false)
  })
  it('分类:EACCES 也算 denied;别的错是 unknown', () => {
    expect(classifyFsError(err('EACCES'))).toBe('denied')
    expect(classifyFsError(err('EIO'))).toBe('unknown')
    expect(classifyFsError(null)).toBe('unknown')
  })
  it('描述:点名哪几个文件夹被拒,并说去哪儿勾', () => {
    const r = probeFsAccess({ home: '/Users/x', platform: 'darwin', readdir: (p) => { if (/Documents|Desktop/.test(p)) throw err('EPERM'); return [] } })
    const d = describeFsAccess(r)
    expect(d).toContain('「Documents」「Desktop」')
    expect(d).toContain('完全磁盘访问')
    expect(describeFsAccess(probeFsAccess({ home: '/h', readdir: () => [] }))).toBe('文件访问正常')
  })
  it('真的去读一次(默认 readdir),不假装', () => {
    const r = probeFsAccess({ home: '/definitely/not/here' })
    expect(r.folders.every(f => f.state === 'missing')).toBe(true)
  })
})

describe('doctor 的文件访问告警 —— 问 daemon 的视角', async () => {
  const { probeFsAccessWarning } = await import('../cli/doctor')
  const daemon = { alive: true, pid: 1, internal_api: { port: 1, token_file_path: '/t' } } as never
  it('daemon 说 denied → 原样带出它的提示', async () => {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ fs_access: { any_denied: true, hint: '系统没给…' } }) })) as unknown as typeof fetch
    expect(await probeFsAccessWarning(daemon, fetchFn, () => 'tok')).toBe('⚠️ 系统没给…')
  })
  it('daemon 说 ok → 不开口', async () => {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ fs_access: { any_denied: false, hint: '正常' } }) })) as unknown as typeof fetch
    expect(await probeFsAccessWarning(daemon, fetchFn, () => 'tok')).toBeNull()
  })
  it('**daemon 没跑 → 本地探,但标明这只是 CLI 的视角**(终端能读不代表 daemon 能读)', async () => {
    const dead = { alive: false, pid: null, internal_api: null } as never
    const w = await probeFsAccessWarning(dead, fetch, () => null, () => ({ anyDenied: true, hint: 'x' }))
    expect(w).toContain('CLI 的视角')
    expect(await probeFsAccessWarning(dead, fetch, () => null, () => ({ anyDenied: false, hint: '' }))).toBeNull()
  })
})
