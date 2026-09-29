// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { restartDaemonAndWait } from '../daemon-restart'
const handAddCmd = defineCommand({
  meta: { name: 'add', description: 'Register a hand the brain can delegate tasks to (run on the BRAIN)' },
  args: {
    id: { type: 'positional', required: true, description: 'Hand id — lowercase slug, e.g. home', valueHint: 'id' },
    url: { type: 'positional', required: true, description: "Hand's A2A url (tailnet), e.g. http://home.ts.net:7000/a2a", valueHint: 'url' },
    name: { type: 'string', description: 'Display name (e.g. 家里) — used in 「让<name>执行 X」' },
    token: { type: 'string', required: true, description: 'Shared pairing token (≥16 chars; the SAME on the hand)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { addHand } = await import('../hand-pairing.ts')
    try {
      addHand(STATE_DIR, { id: args.id, url: args.url, ...(args.name ? { name: args.name } : {}), token: args.token })
      const label = args.name || args.id
      if (args.json) { console.log(JSON.stringify({ ok: true, id: args.id })); return }
      console.log(`已注册手「${label}」(${args.id}) → ${args.url}`)
      console.log(`在「${label}」那台机器上跑: wechat-cc hand accept --token <同一个token>`)
      console.log(`然后微信里说: 让${label}执行 <任务>`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`hand add failed: ${msg}`); process.exit(1)
    }
  },
})

const handAcceptCmd = defineCommand({
  meta: { name: 'accept', description: 'Accept a brain that may delegate tasks to THIS machine (run on the HAND)' },
  args: {
    token: { type: 'string', required: true, description: 'The shared pairing token (same as on the brain)' },
    'brain-id': { type: 'string', default: 'wechat-cc', description: "Brain's a2a self-id (default wechat-cc; must match its WECHAT_A2A_SELF_ID)" },
    'brain-url': { type: 'string', description: "Optional: brain's A2A url (only for the hand to call back later)" },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { acceptBrain } = await import('../hand-pairing.ts')
    try {
      acceptBrain(STATE_DIR, { brainId: args['brain-id'], token: args.token, ...(args['brain-url'] ? { brainUrl: args['brain-url'] } : {}) })
      if (args.json) { console.log(JSON.stringify({ ok: true, brainId: args['brain-id'] })); return }
      console.log(`已接受大脑「${args['brain-id']}」—— 这台现在可被它派活。`)
      console.log('还要:① 开 A2A 监听并绑到你的 Tailscale IP(别用 0.0.0.0):')
      console.log('     wechat-cc daemon a2a enable --host <本机 100.x.y.z> --port 8717,然后重启 daemon')
      console.log('   ② 把 http://<本机 100.x.y.z>:8717/a2a 填给大脑的 `hand add <url>`。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`hand accept failed: ${msg}`); process.exit(1)
    }
  },
})

const handInviteCmd = defineCommand({
  meta: { name: 'invite', description: '一条命令把这台配成「手」:自动开 A2A 监听 + 重启 + 出配对码(在 HAND 那台跑)' },
  args: {
    host: { type: 'string', description: '强制绑定到这个地址(默认自动挑:Tailscale 优先,其次局域网网卡)' },
    port: { type: 'string', description: 'A2A 端口(默认 8717)' },
    url: { type: 'string', description: "完全覆盖这台手的 A2A url(不碰配置、不重启)" },
    cancel: { type: 'boolean', description: 'Cancel any pending invite instead of minting one' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { mintInvite, clearInvite, INVITE_TTL_MS } = await import('../../lib/a2a-pairing.ts')
    if (args.cancel) {
      clearInvite(STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, cancelled: true })); return }
      console.log('已取消待配对邀请。'); return
    }
    try {
      const { hostname } = await import('node:os')
      const { readA2AInfo, cmdDaemonA2AEnable } = await import('../agent.ts')
      const { planHandInvite } = await import('../hand-pairing.ts')
      const { pickAdvertisableHost } = await import('../../lib/local-address.ts')

      let handUrl = args.url
      if (!handUrl) {
        const port = args.port ? Number.parseInt(args.port, 10) : undefined
        if (port !== undefined && !Number.isFinite(port)) throw new Error(`port 得是数字,给的是 ${JSON.stringify(args.port)}`)
        const plan = planHandInvite({
          info: readA2AInfo(STATE_DIR),
          pick: pickAdvertisableHost(),
          ...(args.host ? { host: args.host } : {}),
          ...(port !== undefined ? { port } : {}),
        })
        if (plan.action === 'no_address') {
          throw new Error('找不到能让对端连上的本机地址(只有回环网卡)。装个 Tailscale,或用 --host 指定。')
        }
        if (plan.action === 'ready') {
          handUrl = plan.handUrl
        } else {
          // 挑地址这件事**一定要说出来** —— 多网卡时可能挑错,默默替用户决定
          // 还不告诉他,正是这个仓库反复栽的那种坑。
          const label = plan.why === 'tailscale' ? 'Tailscale 地址' : plan.why === 'lan' ? '局域网地址' : '你指定的地址'
          if (!args.json) console.log(`· 把 A2A 监听开到 ${label} ${plan.host}:${plan.port}(要换用 --host)`)
          cmdDaemonA2AEnable(STATE_DIR, { host: plan.host, port: plan.port })
          if (!args.json) console.log('· 重启 daemon 让它生效…')
          await restartDaemonAndWait(STATE_DIR, `http://${plan.host}:${plan.port}`)
          handUrl = `http://${plan.host}:${plan.port}/a2a`
        }
      }

      // 机器名随码带给大脑 —— 那边就不用再想一个 id/名字了。
      const handName = hostname()
      const { code, expiresMs } = mintInvite(STATE_DIR, { handUrl, nowMs: Date.now(), handName })
      if (args.json) { console.log(JSON.stringify({ ok: true, code, handUrl, handName, expiresMs })); return }
      const mins = Math.round(INVITE_TTL_MS / 60_000)
      console.log(`\n✅ 这台已经可以当「手」了 —— ${handUrl}`)
      console.log(`\n配对码(${mins} 分钟内有效,只能用一次):\n`)
      console.log(`  ${code}\n`)
      console.log('在大脑那台(绑了微信的那台)跑:')
      console.log(`  wechat-cc hand join ${code}`)
      console.log(`\n之后在微信里说「让${handName} 看看…」就派活给这台。`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`hand invite failed: ${msg}`); process.exit(1)
    }
  },
})


const handJoinCmd = defineCommand({
  meta: { name: 'join', description: 'Join a hand using its pairing code — auto-registers both sides (run on the BRAIN)' },
  args: {
    code: { type: 'positional', required: true, description: 'The pairing code from `hand invite`', valueHint: 'code' },
    id: { type: 'string', description: 'Hand id(小写 slug)。默认从码里带来的机器名推 —— 通常不用填' },
    name: { type: 'string', description: '显示名(如 家里)。默认用手那台的机器名 —— 微信里说「让<名字>…」就派给它' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { joinHand } = await import('../hand-pairing.ts')
    const selfId = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
    try {
      const r = await joinHand(STATE_DIR, { code: args.code, selfId, ...(args.id ? { id: args.id } : {}), ...(args.name ? { name: args.name } : {}) })
      if (args.json) { console.log(JSON.stringify(r)); return }
      if (!r.ok) { console.error(`配对失败: ${r.error}`); process.exit(1) }
      // --id/--name 现在都可省 —— 名字随邀请码从手那台带过来了。
      const label = args.name || r.id
      console.log(`✅ 已配对手「${label}」(${r.id}) → ${r.url}`)
      console.log(`微信里说:让${label} <任何话> —— 例如「让${label}看看日志」`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`hand join failed: ${msg}`); process.exit(1)
    }
  },
})

const handListCmd = defineCommand({
  meta: { name: 'list', description: 'Show paired hands (you can delegate to) and brains (can delegate here)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { listPairings } = await import('../hand-pairing.ts')
    const p = listPairings(STATE_DIR)
    if (args.json) { console.log(JSON.stringify(p)); return }
    console.log('可派活的手 (hands you can delegate to):')
    if (p.hands.length === 0) console.log('  (无 —— 在手那台跑 wechat-cc hand invite,再在这台 hand join)')
    for (const h of p.hands) console.log(`  ${h.name}  (${h.id})  →  ${h.url}${h.paused ? '  (paused)' : ''}`)
    console.log('\n可向这台派活的大脑 (brains that can delegate here):')
    if (p.brains.length === 0) console.log('  (无)')
    for (const b of p.brains) console.log(`  ${b.name}  (${b.id})`)
    if (p.others.length > 0) {
      console.log('\n其他 A2A agents:')
      for (const o of p.others) console.log(`  ${o.name}  (${o.id})  [${o.capabilities.join(', ') || '—'}]`)
    }
  },
})

const handPingCmd = defineCommand({
  meta: { name: 'ping', description: "Check whether paired hands are reachable (fetches each hand's Agent Card)" },
  args: {
    target: { type: 'positional', required: false, description: 'A specific hand id or name (default: all)', valueHint: 'id|name' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { pingHands } = await import('../hand-pairing.ts')
    const results = await pingHands(STATE_DIR, args.target ? { filter: args.target } : {})
    if (args.json) { console.log(JSON.stringify(results)); return }
    if (results.length === 0) {
      console.log(args.target ? `没有叫「${args.target}」的手。` : '没有可派活的手(先 hand invite / hand join)。')
      return
    }
    for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}  (${r.id})  ${r.detail}`)
    if (results.some(r => !r.ok)) process.exitCode = 1
  },
})

export const handCmd = defineCommand({
  // Smooth path: `hand invite` on the hand → `hand join <code>` on the brain.
  // Manual path (no daemon needed on the hand yet): `hand add` + `hand accept`.
  meta: { name: 'hand', description: 'Multi-machine (一个大脑多手): pair a brain with hands. Smooth: hand invite → hand join <code>' },
  subCommands: { invite: handInviteCmd, join: handJoinCmd, list: handListCmd, ping: handPingCmd, add: handAddCmd, accept: handAcceptCmd },
})
