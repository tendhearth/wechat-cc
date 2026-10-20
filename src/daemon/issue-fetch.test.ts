import { describe, expect, it } from 'vitest'
import { makeIssueFetcher } from './issue-fetch'

const json = JSON.stringify({ number: 12, title: 'T', body: 'B', url: 'https://github.com/o/r/issues/12', state: 'OPEN', comments: [{ author: { login: 'al' }, body: 'c1' }] })
describe('issue fetcher (gh, read-only)', () => {
  it('runs gh issue view in the project folder with a timeout; maps the JSON', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs: number }> = []
    const f = makeIssueFetcher({ exec: async (cmd, args, o) => { calls.push({ cmd, args, ...o }); return json }, ghPath: () => '/opt/homebrew/bin/gh' })
    const r = await f('/w/proj', 12)
    expect(r).toEqual({ ok: true, issue: { number: 12, title: 'T', body: 'B', url: 'https://github.com/o/r/issues/12', state: 'OPEN', comments: [{ author: 'al', body: 'c1' }] } })
    expect(calls[0]).toMatchObject({ cmd: '/opt/homebrew/bin/gh', args: ['issue', 'view', '12', '--json', 'number,title,body,url,state,comments'], cwd: '/w/proj' })
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(20_000)
  })
  it.each([
    [{ code: 'ENOENT' }, 'gh_missing'],
    [{ stderr: 'gh auth login' }, 'gh_auth'],
    [{ stderr: 'Could not resolve to an issue or pull request with the number of 12' }, 'not_found'],
    [{ stderr: 'none of the git remotes configured for this repository point to a known GitHub host' }, 'not_github'],
    [{ killed: true }, 'timeout'],
    [{ stderr: 'boom' }, 'failed'],
  ])('maps gh failure %o to %s, never throws', async (err, reason) => {
    const f = makeIssueFetcher({ exec: async () => { throw Object.assign(new Error('x'), err) }, ghPath: () => 'gh' })
    expect(await f('/w/p', 12)).toEqual({ ok: false, reason })
  })
  it('no gh installed anywhere ⇒ gh_missing without spawning', async () => {
    let ran = false
    const f = makeIssueFetcher({ exec: async () => { ran = true; return json }, ghPath: () => null })
    expect(await f('/w/p', 1)).toEqual({ ok: false, reason: 'gh_missing' })
    expect(ran).toBe(false)
  })
  it('a response that is not the expected shape ⇒ failed', async () => {
    const f = makeIssueFetcher({ exec: async () => '{"number":"x"}', ghPath: () => 'gh' })
    expect(await f('/w/p', 1)).toEqual({ ok: false, reason: 'failed' })
  })
})
