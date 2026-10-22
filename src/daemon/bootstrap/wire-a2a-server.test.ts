import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { loadAgentConfig } from '../../lib/agent-config'
import { makeSpeechPolicy } from '../speech/policy'
import { makePendingNotices } from '../speech/pending-notices'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { wireA2a } from './wire-a2a'
import { wireA2aServer } from './wire-a2a-server'

const KEY = `wc_${'c'.repeat(32)}`

// 每条测试一个固定端口(配置不收 0;跟仓库里别的 a2a 测试的端口错开)
async function setup(port: number, o: { quiet?: boolean; noSpeech?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'a2a-notify-speech-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({
    provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false,
    a2a_listen: { host: '127.0.0.1', port },
    a2a_agents: [{ id: 'tester', name: 'Tester', url: 'https://tester.example.com/a2a', inbound_api_key: KEY, outbound_api_key: 'out', capabilities: ['notify'], paused: false }],
  }))
  const sent: Array<[string, string]> = [], logs: string[] = []
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }), open: () => ({ sendText: async () => ({ msgId: 'm' }), channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
  const pending = makePendingNotices({ stateDir, log: () => {} })
  const speech = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, n) => (o.quiet ? n + 3600_000 : null), outbound, log: () => {}, pending })
  const slice = wireA2a({ stateDir, db: openTestDb() })
  const w = await wireA2aServer({
    log: (_t, l) => logs.push(l), stateDir, configuredAgent: loadAgentConfig(stateDir),
    a2aRegistry: slice.a2aRegistry, a2aClient: slice.a2aClient, a2aEventsStore: slice.a2aEventsStore,
    dispatchDelegate: (async () => ({ ok: false })) as never,
    resolveOperatorChatId: () => 'owner',
    sendAssistantText: async (c, t) => { sent.push([c, t]); return true },
    speech: () => (o.noSpeech ? null : speech),
    onLetter: undefined as never,
  })
  const notify = (text: string) => fetch(`${w.a2aServer!.baseUrl()}/a2a/notify`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ agent_id: 'tester', text }),
  })
  const done = async () => { await w.a2aServer?.stop(); rmSync(stateDir, { recursive: true, force: true }) }
  return { notify, sent, logs, pending, done }
}

describe('别的 agent 捎给主人的话经 CC 开口那道门(a2a_notify,report)', () => {
  it('照常 ⇒ 经 sendAssistantText 送到主人那条对话', async () => {
    const s = await setup(19931)
    try {
      expect((await s.notify('部署完了')).status).toBe(200)
      expect(s.sent).toEqual([['owner', '[A2A:tester] 部署完了']])
    } finally { await s.done() }
  })
  it('免打扰里 ⇒ 当时不说,进门的待说队列(别人写给主人的不吞)', async () => {
    const s = await setup(19932, { quiet: true })
    try {
      await s.notify('部署完了')
      expect(s.sent).toEqual([])
      expect(s.pending.groups()[0]!.items.map(i => [i.kind, i.text])).toEqual([['a2a_notify', '[A2A:tester] 部署完了']])
    } finally { await s.done() }
  })
  it('门还没接上 ⇒ 不发、记一行(不退回直接发)', async () => {
    const s = await setup(19933, { noSpeech: true })
    try {
      await s.notify('部署完了')
      expect(s.sent).toEqual([])
      expect(s.logs.some(l => l.includes('speech policy not wired yet'))).toBe(true)
    } finally { await s.done() }
  })
})
