// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
// 外部集成反馈 #5 (2026-08-26):allowlist 此前只有"加人"路径(管理员聊天流程),
// 移除要手编 access.json。list/remove 补齐;daemon 的 5s TTL 缓存意味着改动
// 数秒内生效,无需重启。
const accessListCmd = defineCommand({
  meta: { name: 'list', description: 'Show access.json: admins / trusted / allowFrom' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { loadAccess } = await import('../../lib/access.ts')
    const a = loadAccess()
    if (args.json) { console.log(JSON.stringify({ ok: true, dmPolicy: a.dmPolicy, admins: a.admins ?? [], trusted: a.trusted ?? [], allowFrom: a.allowFrom })); return }
    console.log(`dmPolicy: ${a.dmPolicy}`)
    console.log(`admins (${(a.admins ?? []).length}):`); for (const u of a.admins ?? []) console.log(`  ${u}`)
    console.log(`trusted (${(a.trusted ?? []).length}):`); for (const u of a.trusted ?? []) console.log(`  ${u}`)
    console.log(`allowFrom (${a.allowFrom.length}):`); for (const u of a.allowFrom) console.log(`  ${u}`)
  },
})

const accessRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove a userId from allowFrom (admins refuse — self-lockout guard). Takes effect within ~5s, no restart.' },
  args: {
    userId: { type: 'positional', required: true, description: 'The chat/user id to remove', valueHint: 'xxx@im.wechat' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAllowFrom } = await import('../../lib/access.ts')
    const r = removeAllowFrom(args.userId)
    if (args.json) { console.log(JSON.stringify({ ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) })); if (!r.ok) process.exitCode = 1; return }
    if (r.ok) console.log(`✅ 已移除 ${args.userId}(daemon 数秒内生效)`)
    else { console.log(r.reason === 'is_admin' ? `❌ ${args.userId} 是管理员,拒绝移除(防自锁)。` : `❌ ${args.userId} 不在 allowFrom 里。`); process.exitCode = 1 }
  },
})

export const accessCmd = defineCommand({
  meta: { name: 'access', description: 'Allowlist management (list / remove) — the add path stays in the admin chat flow' },
  subCommands: { list: accessListCmd, remove: accessRemoveCmd },
})
