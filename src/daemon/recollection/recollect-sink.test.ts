import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeJournal, type Journal} from '../../core/journal-store'
import {makeRecollectSink} from './recollect-sink'

/**
 * RecollectSink 的 daemon 侧实现:maybeTrigger(taskId, turns) 查 matter
 * (标题 + 算 overnight)、拿便宜模型、交给纯逻辑(src/core/matters/
 * recollection.ts 的 maybeRecollect)判该不该问、该不该写,写就落
 * journal.recordRecollection。
 *
 * `returned` 目前恒传 RETURNED_SIGNAL_UNAVAILABLE(=0,见 recollection.ts
 * 的注释)——「turns 不够格 + overnight 不够格」这组输入如果 returned 真
 * 的接了什么数据源、且那份数据源恰好 ≥1,场景就会够格;这里专门有一条
 * 用例钉住它现在**不会**够格,证明这个常量确实原样传下去、没被悄悄接成
 * 别的东西(fix round 1 的硬要求)。
 */
const TASK = 'a0000001'
const DAY1 = Date.parse('2026-09-23T10:00:00.000Z')
const DAY1_LATER = Date.parse('2026-09-23T22:00:00.000Z')
const DAY2 = Date.parse('2026-09-24T02:00:00.000Z')

describe('makeRecollectSink', () => {
  let db: Db, matters: MatterStore, journal: Journal, logs: Array<[string, string]>
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matters = makeMatterStore(db, () => DAY1)
    journal = makeJournal(db)
    logs = []
    matters.create({id: TASK, kind: 'task', title: '改首页'})
  })
  afterEach(() => db.close())

  it('turns 不够格 + overnight 不够格(returned 恒 0,不会被单独撬开):不问模型、不写 journal', async () => {
    const cheapEval = vi.fn(async () => '不该被叫到')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 1) // turns:1 < STORY_SIGNALS.turns(2);同一天 ⇒ overnight:false
    await vi.waitFor(() => expect(cheapEval).not.toHaveBeenCalled())
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('turns 够格(2):问便宜模型,写进 journal(chatId 用主人默认聊天)', async () => {
    const cheapEval = vi.fn(async (prompt: string) => { expect(prompt).toContain('改首页'); return '那天你让我改首页,我改错了两次。' })
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner-chat', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    expect(journal.list()[0]).toMatchObject({kind: 'recollection', chat_id: 'owner-chat', note: '那天你让我改首页,我改错了两次。'})
    expect(logs).toEqual([])
  })

  it('overnight 单独够格(跨了 UTC 日历日)也触发,即便 turns 是 0', async () => {
    const cheapEval = vi.fn(async () => '第二天早上才通。')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 0)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
  })

  it('matter 不存在(防御性):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1})
    expect(() => sink.maybeTrigger('deadbeef', 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有主人聊天(还没配好主人):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => null, now: () => DAY1})
    expect(() => sink.maybeTrigger(TASK, 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有便宜模型可用(cheapEval() 返回 null):不写、不抛、不算错误(不留痕)', async () => {
    const sink = makeRecollectSink({matters, journal, cheapEval: () => null, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await new Promise(resolve => setImmediate(resolve))
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('便宜模型真的调用失败:留痕(MATTER_RECOLLECT,带 taskId),不写 journal,不抛出', async () => {
    const cheapEval = vi.fn(async () => { throw new Error('gateway_timeout') })
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0))
    expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('gateway_timeout'))).toBe(true)
    expect(journal.list()).toEqual([])
  })

  it('写成功一次之后,同一个 taskId 再触发(哪怕又够格)不会再问、再写第二条', async () => {
    const cheapEval = vi.fn(async () => '第一段回忆。')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    sink.maybeTrigger(TASK, 3) // 又一轮,又够格
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(journal.list()).toHaveLength(1)
  })

  /**
   * fix round 2(2026-09-23,复审新 Important ④):round 1 的 `done` Set 是纯
   * 内存的,daemon 重启就归零——两个 sink 实例(= 两个 daemon 生命周期)共
   * 用同一个 db,复审实测第二次照样写出第二条一模一样的「一段回忆」。改成
   * 持久去重(journal.hasRecollection,v67 的 journal.matter_id)之后,第
   * 二个 sink 实例也认得"这件事已经写过"。
   */
  it('持久去重(v67 journal.matter_id):第二个 sink 实例(模拟 daemon 重启)共用同一个 db,不会再写第二条', async () => {
    const cheapEval1 = vi.fn(async () => '第一次写的回忆。')
    const sink1 = makeRecollectSink({matters, journal, cheapEval: () => cheapEval1, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink1.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))

    // 模拟重启:全新的 sink 实例(全新的内存 Set),但共用同一个 journal/db。
    // now 特意换成 DAY2(overnight 恒真)——如果没有持久去重,门槛照样够格,
    // 这条测试才有鉴别力(不是因为"这次刚好不够格"才没触发)。
    const cheapEval2 = vi.fn(async () => '重启后又写一条(不该发生)。')
    const sink2 = makeRecollectSink({matters, journal, cheapEval: () => cheapEval2, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
    sink2.maybeTrigger(TASK, 0)
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval2).not.toHaveBeenCalled()
    expect(journal.list()).toHaveLength(1)
  })

  /**
   * fix round 2「小的」①:同一次 `settleQuiet` 会因为不同 turnSeq 陆续触发
   * `maybeTrigger`(见 service.ts 的 recollectOnce,它只挡"同一个 turnSeq
   * 再来一次",不挡"不同 turnSeq 连着来")。round 1 的持久去重要等
   * `write` 真的落地才生效,两次调用若都在第一次落地之前抵达,会各问一次
   * 模型、可能各写一条。
   */
  it('in-flight 守卫:同一件事不许同时发起两次模型调用', async () => {
    let resolveAsk: (v: string) => void = () => {}
    const askPromise = new Promise<string>(resolve => { resolveAsk = resolve })
    const cheapEval = vi.fn(() => askPromise)
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2) // 第一次触发,ask() 挂起、还没 resolve
    sink.maybeTrigger(TASK, 3) // 第二个 turnSeq 在第一次写入落地前就到了
    await new Promise(resolve => setImmediate(resolve)) // 让两次同步调用都跑到 ask() 那一步
    expect(cheapEval).toHaveBeenCalledTimes(1) // 没有并发的第二次模型调用
    resolveAsk('写完了。')
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
  })

  /**
   * fix round 2 第 6 项:空回复是 CC 决定"这件事不值得写"的合法结果,不是
   * 错误——但不 latch 掉的话,每次 settle 都会再问一次,持续烧额度且完全
   * 不留痕(这既不是"没模型"也不是"调用失败")。
   */
  it('模型给了空回复:latch 掉(declined)、留痕,不再问', async () => {
    const cheapEval = vi.fn(async () => '   ') // trim 后为空
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('空回复'))).toBe(true))
    expect(journal.list()).toEqual([])
    sink.maybeTrigger(TASK, 3) // 又一轮,又够格——不该再问
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })

  /**
   * fix round 2 第 5 项(指定动作,复审给的变异实验):`returned` 必须原样
   * 传常量,不能被后人接成看起来合理、实则错误的东西(比如把"不是第一
   * 轮"误当成"被打回过",写成 `Math.max(0, turns - 1)`)。turns=2 时那种
   * 错接法算出的 `Math.max(0,1)=1` 恰好等于阈值,`buildRecollectionPrompt`
   * 就会在 prompt 里加一句"被打回或报错过 1 次"——用 turns 本身就够格的
   * 输入(排除"根本没问模型"这种空转),直接断言 prompt 里永远不出现这句
   * 才有鉴别力(光看"问没问模型"在 turns≥2 时怎么都问得到,分不出
   * returned 传对没传对)。
   */
  it('returned 原样等于导出的常量,不会被接错成别的东西——prompt 里永不出现"被打回或报错"(turns 与 overnight 两条轴都要钉住)', async () => {
    const asked: string[] = []
    const cheapEval = vi.fn(async (prompt: string) => { asked.push(prompt); return '写完了。' })
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2) // turns 本身就够格 → 无论 returned 算成什么,ask() 都会被调用
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    expect(asked[0]).not.toContain('被打回或报错')

    // fix round 3(复审 M3):只钉 turns 这一条轴逃不掉 `const returned =
    // overnight ? 1 : 0` 这种错接法——它跟 turns 无关,turns=2 这组输入
    // 根本测不到它。换一个新 matter(上面那条已经把 TASK 标成"写过了",
    // 持久去重会挡住第二次触发),overnight 单独够格、turns=0,同样断言
    // prompt 里不出现"被打回或报错"才有鉴别力。
    const TASK2 = 'b0000002'
    matters.create({id: TASK2, kind: 'task', title: '半夜排查'})
    const sink2 = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
    sink2.maybeTrigger(TASK2, 0)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(2))
    expect(asked[1]).not.toContain('被打回或报错')
  })

  /**
   * fix round 3(2026-09-23,评审 M2):终态那一拍的模型调用是 fire-and-
   * forget,没有 holdBusy 挡着的话空闲自动重启可能切在中间、这条回忆静
   * 默丢失且不留痕(被 abort 不算抛错,.catch 记不到;matter 已经
   * done,不会再有下一拍来补)。这条钉住:发起模型调用之前就该持有 token
   * (ask() 还没 resolve 时 token 已经在手),真正写完(或声明放弃)之后
   * 才放开。
   */
  it('holdBusy:模型调用期间持有 busy token,收尾(写完/声明放弃)才放开', async () => {
    let resolveAsk: (v: string) => void = () => {}
    const askPromise = new Promise<string>(resolve => { resolveAsk = resolve })
    const cheapEval = vi.fn(() => askPromise)
    const held: string[] = []
    const released: string[] = []
    const holdBusy = (label: string) => { held.push(label); return () => { released.push(label) } }
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l]), holdBusy})
    sink.maybeTrigger(TASK, 2)
    await new Promise(resolve => setImmediate(resolve))
    expect(held).toEqual(['recollect']) // ask() 还没 resolve,token 已经在手
    expect(released).toEqual([])
    resolveAsk('写完了。')
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    await vi.waitFor(() => expect(released).toEqual(['recollect']))
  })
})
