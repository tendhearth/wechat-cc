import { describe, expect, it } from 'vitest'
import { makeFixtureApi, utf8Base64 } from './preview.js'

describe('workbench labeled preview fixture', () => {
  it('encodes Chinese preview text as UTF-8 base64', () => {
    const encoded = utf8Base64('这是样例内容')
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))).toBe('这是样例内容')
  })

  it('supports create, continue and exact-version approval fixture interactions', async () => {
    const fixture = makeFixtureApi('empty', 1_800_000_000_000)
    expect((await fixture.api('GET', '/v1/workbench') as any).tasks).toEqual([])

    const created = await fixture.api('POST', '/v1/workbench/create', { path: '/tmp/work', providerId: 'codex', text: '整理访谈' }) as any
    expect(created.task).toMatchObject({ id: 'c0ffee12', status: 'running' })

    fixture.setState('completed')
    const continued = await fixture.api('POST', '/v1/workbench/continue', { id: '7a3c9f2e', text: '再补一页结论' }) as any
    expect(continued.task.status).toBe('running')
    const runningDetail = await fixture.api('GET', '/v1/workbench/task?id=7a3c9f2e') as any
    expect(runningDetail.events.at(-1).text).toBe('再补一页结论')

    fixture.setState('completed')
    const before = await fixture.api('GET', '/v1/workbench/task?id=7a3c9f2e') as any
    const artifact = before.artifacts[0]
    await fixture.api('POST', '/v1/workbench/approve', { id: '7a3c9f2e', artifactId: artifact.id, sha256: artifact.sha256 })
    const after = await fixture.api('GET', '/v1/workbench/task?id=7a3c9f2e') as any
    expect(after.artifacts[0].approvedAt).toBe(1_800_000_000_000)
  })

  it('uses contract-shaped task, artifact and SHA identifiers', async () => {
    const fixture = makeFixtureApi('completed', 1_800_000_000_000)
    const detail = await fixture.api('GET', '/v1/workbench/task?id=7a3c9f2e') as any
    expect(detail.task.id).toMatch(/^[0-9a-f]{8}$/)
    expect(detail.artifacts[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(detail.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
