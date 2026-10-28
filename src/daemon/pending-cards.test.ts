import { describe, it, expect } from 'vitest'
import { openTestDb, type Db } from '../lib/db'
import { PendingPermissions } from './pending-permissions'
import { cardSummary, makePendingCardJournal, makePendingCardsStore, reportVoidedCards, takeVoidedCards, voidedCardsNotice } from './pending-cards'

const OWNER = 'owner@im.wechat'
const OTHER = 'other@im.wechat'
const noLog = () => {}

/** 一个进程的待批登记处,落进同一个库(= 同一个 stateDir 的 wechat-cc.db)。 */
const registryOn = (db: Db) => new PendingPermissions(makePendingCardJournal(makePendingCardsStore(db), noLog))
const rows = (db: Db) => db.query<{ hash: string; chat_id: string; summary: string }, []>('SELECT hash,chat_id,summary FROM pending_cards ORDER BY created_at,hash').all()

function fakeSpeech() {
  const said: Array<{ kind: string; chatId: string; text: string }> = []
  return { said, speech: { async tell(kind: 'restart_voided_cards', chatId: string, text: string) { said.push({ kind, chatId, text }); return true } } }
}

describe('cardSummary — 卡上一句话说要做什么', () => {
  it('头一行以冒号收尾就接上第二行(Codex 的卡)', () => {
    expect(cardSummary('Codex 想执行命令:\nrm -rf dist')).toBe('Codex 想执行命令:rm -rf dist')
  })
  it('一行的照原样,空白压成一个', () => {
    expect(cardSummary('Claude wants to run   Bash  ls')).toBe('Claude wants to run Bash ls')
  })
  it('超长截断到 40 字加「…」,密钥先打码', () => {
    const s = cardSummary(`Codex 想执行命令:\n${'x'.repeat(100)}`)
    expect([...s]).toHaveLength(40)
    expect(s.endsWith('…')).toBe(true)
    expect(cardSummary('Codex 想执行命令:\ncurl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123"')).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123')
  })
})

describe('cardSummary 打码:卡上那句话进库、进微信,常见的密钥写法都遮掉', () => {
  const cases: Array<[string, string, string]> = [
    ['sshpass -p', 'sshpass -p hunter2 ssh me@host', 'hunter2'],
    ['mysql -p 连写', 'mysql -uroot -pSECRETpw db', 'SECRETpw'],
    ['mysql --password=', 'mysql --password=SECRETpw db', 'SECRETpw'],
    ['curl -u', 'curl -u alice:s3cretpw https://x.example', 's3cretpw'],
    ['curl --user', 'curl --user alice:s3cretpw https://x.example', 's3cretpw'],
    ['URL 里的账号密码', 'git clone https://alice:s3cretpw@git.example/r', 's3cretpw'],
    ['Bearer 不透明令牌', 'curl -H "Authorization: Bearer abcDEF123456xyz" x', 'abcDEF123456xyz'],
    ['Basic', 'curl -H "Authorization: Basic YWxpY2U6czNjcmV0" x', 'YWxpY2U6czNjcmV0'],
  ]
  for (const [name, cmd, secret] of cases) {
    it(name, () => {
      const s = cardSummary(cmd)
      expect(s).not.toContain(secret)
      expect(s).toContain('[已打码]')
    })
  }
  it('不误伤:mkdir -p、ssh -p 端口、普通网址照原样', () => {
    expect(cardSummary('mkdir -p dist && ls')).toBe('mkdir -p dist && ls')
    expect(cardSummary('ssh -p 2222 me@host')).toBe('ssh -p 2222 me@host')
    expect(cardSummary('curl https://example.com/a')).toBe('curl https://example.com/a')
  })
})

describe('voidedCardsNotice — 给主人的那一句', () => {
  it('一张', () => {
    expect(voidedCardsNotice(['Codex 想执行命令:rm -rf dist'])).toBe('重启前那张「Codex 想执行命令:rm -rf dist」的卡作废了，还要的话再说一次。')
  })
  it('几张合成一条,逐行列出', () => {
    expect(voidedCardsNotice(['Codex 想执行命令:rm -rf dist', 'Codex 想改文件:a.ts'])).toBe('重启前有 2 张卡作废了：\n「Codex 想执行命令:rm -rf dist」\n「Codex 想改文件:a.ts」\n还要的话再说一次。')
  })
})

describe('待批登记处落 pending_cards:开卡写、了结删', () => {
  it('开卡写一行;批 / 拒 / 没送到 / 过期 / 被同 id 顶掉都删掉', async () => {
    const db = openTestDb()
    const reg = registryOn(db)
    void reg.register('aaaaa', 60_000, { chatId: OWNER, prompt: 'Codex 想执行命令:\nrm -rf a' })
    void reg.register('bbbbb', 60_000, { chatId: OWNER, prompt: 'Codex 想执行命令:\nrm -rf b' })
    void reg.register('ccccc', 60_000, { chatId: OWNER, prompt: 'Codex 想执行命令:\nrm -rf c' })
    void reg.register('ddddd', 0, { chatId: OWNER, prompt: 'Codex 想执行命令:\nrm -rf d' })
    expect(rows(db).map(r => r.summary)).toEqual(['Codex 想执行命令:rm -rf a', 'Codex 想执行命令:rm -rf b', 'Codex 想执行命令:rm -rf c', 'Codex 想执行命令:rm -rf d'])
    reg.consume('aaaaa', 'allow')
    reg.consume('bbbbb', 'deny')
    reg.fail('ccccc')
    reg.sweep()
    expect(rows(db)).toEqual([])
    const first = reg.register('eeeee', 60_000, { chatId: OWNER, prompt: 'first' })
    void reg.register('eeeee', 60_000, { chatId: OWNER, prompt: 'second' })
    await expect(first).resolves.toBe('timeout')
    expect(rows(db).map(r => r.summary)).toEqual(['second'])
  })

  it('没有 chat 的(只登记、手机拍板)不记 —— 重启后没处说', () => {
    const db = openTestDb()
    void registryOn(db).register('fffff', 60_000, { chatId: '', prompt: 'x' })
    expect(rows(db)).toEqual([])
  })
})

describe('重启:上一个进程留下的卡作废,告诉主人一次', () => {
  it('崩了(没走关机,条目没了结)也留得下:下次开机按 chat 各说一次,说完清表,再开机不再说', async () => {
    const db = openTestDb()
    const before = registryOn(db)
    void before.register('aaaaa', 600_000, { chatId: OWNER, prompt: 'Codex 想执行命令:\nrm -rf dist' })
    void before.register('bbbbb', 600_000, { chatId: OWNER, prompt: 'Codex 想改文件:\nsrc/a.ts' })
    void before.register('ccccc', 600_000, { chatId: OTHER, prompt: 'Codex 想执行命令:\nnpm publish' })
    // 进程没了(崩溃 = 什么都不收尾)。下一次开机:
    const bootAt = Date.now() + 1
    const voided = takeVoidedCards(makePendingCardsStore(db), bootAt, noLog)
    // 开机后新开的卡(同一个 hash 也行)是这一轮的,不算作废
    const after = registryOn(db)
    const fresh = makePendingCardsStore(db)
    fresh.add({ hash: 'zzzzz', chatId: OWNER, summary: '这一轮的', createdAt: bootAt, expiresAt: bootAt + 600_000 })
    const { said, speech } = fakeSpeech()
    await reportVoidedCards({ voided, now: bootAt, speech, log: noLog })
    expect(said).toEqual([
      { kind: 'restart_voided_cards', chatId: OWNER, text: '重启前有 2 张卡作废了：\n「Codex 想执行命令:rm -rf dist」\n「Codex 想改文件:src/a.ts」\n还要的话再说一次。' },
      { kind: 'restart_voided_cards', chatId: OTHER, text: '重启前那张「Codex 想执行命令:npm publish」的卡作废了，还要的话再说一次。' },
    ])
    expect(rows(db).map(r => r.hash)).toEqual(['zzzzz'])
    // 新进程的登记处是空的:迟到的「y」没有东西可批
    expect(after.list()).toEqual([])
    expect(after.consume('aaaaa', 'allow')).toBe(false)
    // 再开机一次:不再说
    const again = fakeSpeech()
    await reportVoidedCards({ voided: takeVoidedCards(makePendingCardsStore(db), bootAt, noLog), now: bootAt, speech: again.speech, log: noLog })
    expect(again.said).toEqual([])
  })

  it('门抛了(没交出去)⇒ 那个 chat 的行留着,下次开机再说;回来了(说出去 / 进了待说队列)的 chat 才清', async () => {
    const db = openTestDb()
    const store = makePendingCardsStore(db)
    store.add({ hash: 'aaaaa', chatId: OWNER, summary: '给主人的', createdAt: 1_000, expiresAt: 900_000 })
    store.add({ hash: 'bbbbb', chatId: OTHER, summary: '给另一个的', createdAt: 1_000, expiresAt: 900_000 })
    const speech = {
      async tell(_k: 'restart_voided_cards', chatId: string) {
        if (chatId === OTHER) throw new Error('outbound.open threw')
        return false   // 推后了:门已经放进落盘的待说队列
      },
    }
    await reportVoidedCards({ voided: takeVoidedCards(store, 10_000, noLog), now: 10_000, speech, log: noLog })
    expect(rows(db).map(r => r.hash)).toEqual(['bbbbb'])
    // 下次开机:再说一次,这回交出去了 ⇒ 清掉
    const next = fakeSpeech()
    await reportVoidedCards({ voided: takeVoidedCards(store, 20_000, noLog), now: 20_000, speech: next.speech, log: noLog })
    expect(next.said.map(s => s.chatId)).toEqual([OTHER])
    expect(rows(db)).toEqual([])
  })

  it('停机久到卡本来就过期了 ⇒ 不提,照样清掉', async () => {
    const db = openTestDb()
    makePendingCardsStore(db).add({ hash: 'aaaaa', chatId: OWNER, summary: 'old', createdAt: 1_000, expiresAt: 2_000 })
    const { said, speech } = fakeSpeech()
    await reportVoidedCards({ voided: takeVoidedCards(makePendingCardsStore(db), 10_000, noLog), now: 10_000, speech, log: noLog })
    expect(said).toEqual([])
    expect(rows(db)).toEqual([])
  })
})
