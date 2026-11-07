import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WIRE_ROUTE_ALIASES, type WireRouteAlias } from '../../packages/protocol/src/wire-compat'
import { formatRetireCheck, makeRouteUsage, readRouteUsage, retireCheck, ROUTE_USAGE_FILE, type RouteUsage } from './route-usage'
const DAY = 86_400_000, now = Date.parse('2026-11-06T12:00:00Z')
const alias = WIRE_ROUTE_ALIASES.find(r => r.readers.includes('app'))!
const desktop = WIRE_ROUTE_ALIASES.find(r => r.readers.includes('desktop'))!
const dirs: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'p3h-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const data = (version = '3'): RouteUsage => ({ since: now - 31 * DAY, rows: [{ day: '2026-11-06', client: 'app', version, alias: '', count: 1 }] })
const check = (d: RouteUsage | null, row = alias) => retireCheck(d, now, [row])[0]!

describe('route retirement evidence', () => {
  it('permits only a full window, no alias calls and upgraded active clients', () => {
    expect(check(data()).eligible).toBe(true)
    for (const version of ['2', 'unknown', '3beta', '']) expect(check(data(version)).eligible).toBe(false)
    expect(check(null).eligible).toBe(false)
    expect(check({ since: now - 29 * DAY, rows: [] }).eligible).toBe(false)
    expect(check({ since: now + DAY, rows: [] }).eligible).toBe(false)
  })
  it('counts every observed version conservatively, including old builds before an upgrade', () => {
    const d = data()
    d.rows.push({ ...d.rows[0]!, version: '2', day: '2026-10-07' })
    expect(check(d).reasons.join()).toContain('app/2')
    d.rows[1]!.day = '2026-10-06'
    expect(check(d).eligible).toBe(true)
  })
  it('blocks calls even from a new client, and explains client, day and count', () => {
    const d = data(); d.rows.push({ ...d.rows[0]!, alias: alias.from, count: 7 })
    expect(formatRetireCheck([check(d)])).toContain('app/3 2026-11-06 ×7')
    expect(check(d).eligible).toBe(false)
  })
  it('cached webpages with no P3g marker and unpublished desktop versions block retirement', () => {
    const d = data(); d.rows.push({ day: '2026-11-06', client: 'web', version: 'unknown', alias: '', count: 1 })
    expect(check(d).reasons.join()).toContain('web/unknown')
    d.rows[1]!.version = 'P3g'; expect(check(d).eligible).toBe(true)
    expect(check(data(), desktop).reasons.join()).toContain('尚未发布/登记')
    const released: WireRouteAlias = { ...desktop, retirement: [{ client: 'desktop', milestone: 'P3e', minimum: '1.8.0' }] }
    for (const [version, eligible] of [['1.7.9', false], ['1.8.0', true], ['1.10.0', true], ['1.8.0-beta', false]] as const) {
      expect(check({ ...data(), rows: [{ day: '2026-11-06', client: 'desktop', version, alias: '', count: 1 }] }, released).eligible).toBe(eligible)
    }
  })
  it('daily counters survive restarts, separate method/client/version, prune history and omit contents', () => {
    const d = dir(); let at = now - 31 * DAY
    const note = makeRouteUsage(d, () => at)
    note('app', '2', alias.from); at = now
    note('app', '3', alias.from); makeRouteUsage(d, () => at)('app', '3', alias.from)
    note('web', 'P3g', alias.to + '?secret=never-store')
    const stored = readRouteUsage(d)!
    expect(stored.rows).toHaveLength(3)
    expect(stored.rows.find(r => r.alias === alias.from)?.count).toBe(2)
    expect(stored.rows.some(r => r.version === '2')).toBe(false)
    expect(readFileSync(join(d, ROUTE_USAGE_FILE), 'utf8')).not.toContain('secret')
    writeFileSync(join(d, ROUTE_USAGE_FILE), '{broken')
    expect(readRouteUsage(d)).toBeNull()
    note('app', '3'); expect(readRouteUsage(d)?.since).toBe(now)
    expect(check(readRouteUsage(d)).eligible).toBe(false)
  })
  it('runs the real CLI on fabricated evidence without writing or opening a database', () => {
    const d = dir(); const fixture = data(); fixture.since = Date.now() - 31 * DAY
    fixture.rows = []; writeFileSync(join(d, ROUTE_USAGE_FILE), JSON.stringify(fixture))
    const before = readFileSync(join(d, ROUTE_USAGE_FILE), 'utf8')
    const result = spawnSync('bun', ['cli.ts', 'routes', 'retire-check', '--json'], { encoding: 'utf8', env: { ...process.env, WECHAT_STATE_DIR: d } })
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.find((r: { alias: string }) => r.alias === alias.from).eligible).toBe(true)
    expect(output.find((r: { alias: string }) => r.alias === desktop.from).eligible).toBe(false)
    expect(readFileSync(join(d, ROUTE_USAGE_FILE), 'utf8')).toBe(before)
    expect(readdirSync(d)).toEqual([ROUTE_USAGE_FILE])
  })
})


it('counts prefix aliases under the table key without retaining file names', () => {
  const d = dir(), sticker = WIRE_ROUTE_ALIASES.find(r => r.from.endsWith('/'))!
  const note = makeRouteUsage(d, () => now)
  note('app', '3', sticker.from + 'private-filename.png')
  expect(readRouteUsage(d)!.rows.find(r => r.alias === sticker.from)?.count).toBe(1)
  expect(readFileSync(join(d, ROUTE_USAGE_FILE), 'utf8')).not.toContain('private-filename')
})


it('does not mistake an unmarked page navigation or pairing for an old webpage API client', () => {
  const d = dir(), note = makeRouteUsage(d, () => now)
  note('web', undefined, 'GET /m')
  note('web', undefined, 'POST /set/api/pair')
  expect(readRouteUsage(d)).toBeNull()
  note('web', 'P3g', 'GET /v1/home')
  expect(readRouteUsage(d)!.rows.map(r => r.version)).toEqual(['P3g'])
})

describe('route usage on the hot request path', () => {
  it('writes a new row at once, but repeats only flush once a minute (count is a lower bound)', () => {
    const d = dir(); let t = now
    const record = makeRouteUsage(d, () => t)
    const file = join(d, ROUTE_USAGE_FILE)
    const count = () => readRouteUsage(d)!.rows.find(r => r.alias === alias.from)?.count
    record('app', '2', alias.from)
    expect(count()).toBe(1)
    const before = readFileSync(file, 'utf8')
    for (let i = 0; i < 20; i++) { t += 1000; record('app', '2', alias.from) }
    expect(readFileSync(file, 'utf8')).toBe(before)
    record('app', '2', desktop.from)
    expect(readRouteUsage(d)!.rows.some(r => r.alias === desktop.from)).toBe(true)
    t += 61_000; record('app', '2', alias.from)
    expect(count()).toBe(2)
  })
})
