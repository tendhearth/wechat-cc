/**
 * 路由表的**行为快照**(重构第二批 5a,2026-10-20)。
 *
 * `fixtures/routes-snapshot-2026-10-20.json` 是改表之前 origin/dev(eb3c828c)上各份名单的原样:
 * 每条 /v1 路由的档位、各种令牌的 routeAllow(operator / 设备 / 链接 / federation / selftest)、
 * PHONE_ROUTES、LINK_READ_OK / LINK_WRITE_OK(连理由)、LINK_ROUTES、LAN_ONLY_OPS、PHONE_TOPICS,
 * 以及 lib.rs workbench_request_allowed 与 workbench-proxy.ts ROUTES 里解析出来的元组。
 *
 * 这里断言:只看快照里**已有的路由**,从路由表推出来的每一份和快照逐条相等(5a 提交时是整份相等,
 * 没有一条新路由)。于是:
 * - 新加一条路由不用碰快照(「加一行 + gen:routes」照旧成立);
 * - 已有路由的档位 / 令牌 / link 变了、或者被删了,这里红 —— 有意为之(比如 5b 收敛)就把快照里那一条
 *   一起改,并在 PR 里写明。
 * 快照不从表重新生成(那就是「实现验证实现」,永远绿)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_MIN_TIER, routesForToken } from '../src/daemon/internal-api/route-tiers'
import { makeTokenRegistry } from '../src/daemon/internal-api/token-registry'
import { LAN_ONLY_OPS, LINK_READ_OK, LINK_ROUTES, LINK_WRITE_OK, MERGED_ALIASES, PHONE_ROUTES, PHONE_TOPICS } from '../src/features/phone/phone-routes'
import { WORKBENCH_ROUTES_JSON } from './gen-routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const snap = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'routes-snapshot-2026-10-20.json'), 'utf8'))
const generated = JSON.parse(readFileSync(WORKBENCH_ROUTES_JSON, 'utf8')) as { tauri: string[]; devProxy: string[] }
/** 快照里出现过的路由;表里后来新加的不在这里,不参与比较。 */
const KNOWN: ReadonlySet<string> = new Set([...Object.keys(snap.ROUTE_MIN_TIER), ...snap.PHONE_ROUTES])
const sorted = (a: Iterable<string>) => [...a].filter(k => KNOWN.has(k)).sort()
const known = <T>(o: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(o).filter(([k]) => KNOWN.has(k)))
/**
 * 已并成别名的那几条(P3c 起,设计稿 2026-11-05-p3-one-route-family「守卫」):手机令牌的集合按「新键 ∪ 别名键」比 ——
 * 别名键(旧的 `/m/api/…`)照旧在集合里、和快照逐条比;新键(`/v1` 那一行)是同一份数据的另一个名字,比的时候拿掉,
 * 另由下面「别名的新键」那一条核对:新键在不在、link 与理由,都和它的别名键一模一样(集合不许借新键变大)。
 */
const ALIAS_TARGETS: ReadonlySet<string> = new Set(MERGED_ALIASES.map(a => a.to))
const phoneSide = (a: Iterable<string>) => [...a].filter(k => !ALIAS_TARGETS.has(k))
const knownPhone = <T>(o: Readonly<Record<string, T>>) => known(Object.fromEntries(Object.entries(o).filter(([k]) => !ALIAS_TARGETS.has(k))))

describe('从路由表推出来的名单与改造前快照逐条一致', () => {
  it('ROUTE_MIN_TIER(每条 /v1 路由的档位)', () => {
    expect(known(ROUTE_MIN_TIER)).toEqual(snap.ROUTE_MIN_TIER)
  })
  it('各种令牌的 routeAllow', () => {
    const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
    reg.registerOperatorToken('op')
    expect({
      operator: sorted(reg.resolve('op')!.routeAllow!),
      device: sorted(phoneSide(PHONE_ROUTES)),
      link: sorted(phoneSide(LINK_ROUTES)),
      federation: sorted(routesForToken('federation')),
      selftest: sorted(routesForToken('selftest')),
    }).toEqual(snap.tokenAllow)
  })
  // 新加的路由不比(上面 filter 掉了),但「哪些令牌能碰它」得有人点头:operator(桌面 / CLI 共用的长效令牌)、
  // federation(另一台 CC)、selftest、链接令牌,名单整份比 = 快照 + 下面明列的新增。往表里加 tokens:['operator']
  // 或 link:'read'|'write' 而不改这里 ⇒ 红(#471 评审)。链接令牌那一份另有 link-routes-from-source.guard.test.ts 对着
  // 链接页面源码核对(理念 2,10-21):收回的 22 条已从快照的 link / LINK_* 里删掉,所以这里 link 的新增照旧是空。
  it('令牌能碰到的范围:新增必须在这里显式点头', () => {
    // operator:记忆编辑(2026-10-23,设计稿 memory-edits-stick):改的是主人自己的记忆,trusted 那把 file token 别人对话的会话也有,只能给 operator。
    // operator:架构终态 F6(主人 2026-10-26 拍板):桌面不再起 CLI 读写的主人私事(记忆页原样文件 / 画像 / 本机项目记忆、对话页、会话名单、
    // 观察 / 里程碑 / 决策、头像、admins、对话模式快照)改走 daemon,经宿主代理用 operator 凭据;别人对话的记录不能给 trusted。
    const F6_DESKTOP_OWNER = [
      'GET /v1/memory/files',
      'GET /v1/memory/file',
      'POST /v1/memory/file/write',
      'GET /v1/memory/profile',
      'GET /v1/memory/profile/status',
      'GET /v1/memory/projects',
      'GET /v1/conversations/list',
      'GET /v1/observations/list',
      'POST /v1/observations/archive',
      'GET /v1/milestones/list',
      'GET /v1/events/list',
      'GET /v1/access/list',
      'GET /v1/avatar/info',
      'POST /v1/avatar/set',
      'POST /v1/avatar/remove',
      'GET /v1/sessions/projects',
      'GET /v1/sessions/chats',
      'POST /v1/sessions/delete',
      'GET /v1/dialogue/timeline',
      'GET /v1/dialogue/threads',
      'GET /v1/dialogue/thread',
      'GET /v1/dialogue/search',
      'POST /v1/dialogue/unlock',
    ]
    // operator:AI 输出回归评测(2026-10-29,docs/design/2026-10-29-output-eval.md):`wechat-cc eval run` 起一条只读、不批权限、不发微信的真会话,同 selftest/converse。
    const OUTPUT_EVAL = ['POST /v1/eval/run']
    // operator:一件事上的动作收进 /v1/matter/*(P3e,设计稿 2026-11-05-p3-one-route-family):operator 本来就能走它们的 /v1/workbench/* 双胞胎
    // (cancel / permission / answer / artifact / quota-handoff / worktree / create-entry / entry-receipt,还在快照里),新键是同一个处理器,够得着的不变。
    const P3E_MATTER_ACTIONS = ['POST /v1/matter/stop', 'POST /v1/matter/permission', 'POST /v1/matter/answer', 'GET /v1/matter/artifact', 'POST /v1/matter/handoff', 'POST /v1/matter/worktree', 'POST /v1/matter/create', 'GET /v1/matter/create-receipt',
      // P3e-2(双胞胎:rewind-preview / rewind / review / review-mark / review-return / review-comment / review-comments-send)
      'GET /v1/matter/rewind', 'POST /v1/matter/rewind', 'GET /v1/matter/changes', 'POST /v1/matter/review-mark', 'POST /v1/matter/review-return', 'POST /v1/matter/review-comment', 'POST /v1/matter/review-comments-send']
    const APPROVED_ADDITIONS: Record<'operator' | 'federation' | 'selftest' | 'link', string[]> = { operator: ['GET /v1/matter/owner-chat/file', 'POST /v1/memory/edit', 'POST /v1/memory/view', 'GET /v1/memory/retractions', 'POST /v1/memory/retractions/restore', ...F6_DESKTOP_OWNER, ...OUTPUT_EVAL, ...P3E_MATTER_ACTIONS], federation: [], selftest: [], link: [] }
    const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
    reg.registerOperatorToken('op')
    const all = (a: Iterable<string>) => [...a].sort()
    const want = (k: keyof typeof APPROVED_ADDITIONS) => [...snap.tokenAllow[k], ...APPROVED_ADDITIONS[k]].sort()
    expect(all(reg.resolve('op')!.routeAllow!)).toEqual(want('operator'))
    expect(all(routesForToken('federation'))).toEqual(want('federation'))
    expect(all(routesForToken('selftest'))).toEqual(want('selftest'))
    expect(all(phoneSide(LINK_ROUTES))).toEqual(want('link'))
  })
  it('PHONE_ROUTES / LINK_ROUTES / LAN_ONLY_OPS / PHONE_TOPICS', () => {
    expect(sorted(phoneSide(PHONE_ROUTES))).toEqual(snap.PHONE_ROUTES)
    expect(sorted(phoneSide(LINK_ROUTES))).toEqual(snap.LINK_ROUTES)
    // 这两份不是路由:整份比
    expect([...LAN_ONLY_OPS].sort()).toEqual(snap.LAN_ONLY_OPS)
    expect([...PHONE_TOPICS].sort()).toEqual(snap.PHONE_TOPICS)
  })
  it('别名的新键:手机令牌经新键够得着的,和别名键一模一样(在不在、link、理由)', () => {
    expect(MERGED_ALIASES.length, '没有已并的行 ⇒ 这一条空转').toBeGreaterThan(0)
    for (const a of MERGED_ALIASES) {
      expect(PHONE_ROUTES.has(a.from), `${a.from}:别名键要在设备令牌的集合里`).toBe(true)
      expect(PHONE_ROUTES.has(a.to), `${a.to}:新键要在设备令牌的集合里`).toBe(true)
      expect(LINK_ROUTES.has(a.to), `${a.to}:链接令牌能不能走,同别名键`).toBe(LINK_ROUTES.has(a.from))
      expect(LINK_READ_OK[a.to], `${a.to}:读的理由同别名键`).toBe(LINK_READ_OK[a.from])
      expect(LINK_WRITE_OK[a.to], `${a.to}:写的理由同别名键`).toBe(LINK_WRITE_OK[a.from])
    }
  })
  it('LINK_READ_OK / LINK_WRITE_OK 连理由逐字一致', () => {
    expect(knownPhone(LINK_READ_OK)).toEqual(snap.LINK_READ_OK)
    expect(knownPhone(LINK_WRITE_OK)).toEqual(snap.LINK_WRITE_OK)
  })
  it('lib.rs 与 dev 代理的放行名单(生成物)和改造前源码里的元组一致', () => {
    expect(sorted(generated.tauri)).toEqual(snap.tauriAllowed)
    expect(sorted(generated.devProxy)).toEqual(snap.devProxyRoutes)
  })
})
