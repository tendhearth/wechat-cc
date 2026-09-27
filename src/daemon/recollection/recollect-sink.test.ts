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
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 1) // turns:1 < STORY_SIGNALS.turns(2);同一天 ⇒ overnight:false
    await vi.waitFor(() => expect(cheapEval).not.toHaveBeenCalled())
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('turns 够格(2):问便宜模型,写进 journal(chatId 用主人默认聊天)', async () => {
    const cheapEval = vi.fn(async (prompt: string) => { expect(prompt).toContain('改首页'); return '那天你让我改首页,我改错了两次。' })
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner-chat', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    expect(journal.list()[0]).toMatchObject({kind: 'recollection', chat_id: 'owner-chat', note: '那天你让我改首页,我改错了两次。'})
    expect(logs).toEqual([])
  })

  it('overnight 单独够格(跨了 UTC 日历日)也触发,即便 turns 是 0', async () => {
    const cheapEval = vi.fn(async () => '第二天早上才通。')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 0)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
  })

  it('matter 不存在(防御性):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1})
    expect(() => sink.maybeTrigger('deadbeef', 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有主人聊天(还没配好主人):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => null, now: () => DAY1})
    expect(() => sink.maybeTrigger(TASK, 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有便宜模型可用(cheapEval() 返回 null):不写、不抛、不算错误(不留痕)', async () => {
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => null, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await new Promise(resolve => setImmediate(resolve))
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('便宜模型真的调用失败:留痕(MATTER_RECOLLECT,带 taskId),不写 journal,不抛出', async () => {
    const cheapEval = vi.fn(async () => { throw new Error('gateway_timeout') })
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0))
    expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('gateway_timeout'))).toBe(true)
    expect(journal.list()).toEqual([])
  })

  it('写成功一次之后,同一个 taskId 再触发(哪怕又够格)不会再问、再写第二条', async () => {
    const cheapEval = vi.fn(async () => '第一段回忆。')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
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
    const sink1 = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval1, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink1.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))

    // 模拟重启:全新的 sink 实例(全新的内存 Set),但共用同一个 journal/db。
    // now 特意换成 DAY2(overnight 恒真)——如果没有持久去重,门槛照样够格,
    // 这条测试才有鉴别力(不是因为"这次刚好不够格"才没触发)。
    const cheapEval2 = vi.fn(async () => '重启后又写一条(不该发生)。')
    const sink2 = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval2, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
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
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
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
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('空/退化回复'))).toBe(true))
    expect(journal.list()).toEqual([])
    sink.maybeTrigger(TASK, 3) // 又一轮,又够格——不该再问
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })

  /**
   * 终审必判④(a):终审的探针实测——matter 23:50 UTC 建、00:10 终态,
   * turns=0,prompt 给了"跨了一夜才有回复"这个假前提,模型老实答"无",
   * `recordRecollection` 的 trim-empty 守卫拦不住(“无”不是空字符串),落
   * 库 note='无'、hasRecollection 翻真——那件事唯一的配额永久花在"无"这
   * 个字上。这几条钉住常见的退化回复都会被 latch 掉、不写进 journal。
   */
  it.each(['无', '没有', '(空)', '（空）', '没什么可记的', '  无  ', 'none', 'N/A'])(
    '退化回复 %j:latch 掉、留痕,不写进 journal',
    async (reply) => {
      const cheapEval = vi.fn(async () => reply)
      const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
      sink.maybeTrigger(TASK, 2)
      await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('空/退化回复'))).toBe(true))
      expect(journal.list()).toEqual([])
    },
  )

  /**
   * 反证:过滤器没有矫枉过正——终审后修复第二轮 Minor:原来这条用的反证
   * 文本("那天你让我改首页,我改错了两次。")恰好不含任何退化词,测不出
   * "精确匹配"和"包含退化词就误杀"(`.some(d=>normalized.includes(d))`)
   * 这两种写法的差别——复审把 isDegenerateReply 变异成后者,这条用例照
   * 样全绿(25 条)。换成含"没有"这个退化词、但整句明显不是在说"不写"
   * 的记述,才有鉴别力。
   */
  it('不是退化回复的正常记述照常写进 journal(反证:过滤器没有矫枉过正)', async () => {
    const cheapEval = vi.fn(async () => '我没有找到原因，折腾了三个小时。')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    expect(journal.list()[0]!.note).toBe('我没有找到原因，折腾了三个小时。')
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
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
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
    const sink2 = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
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
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l]), holdBusy})
    sink.maybeTrigger(TASK, 2)
    await new Promise(resolve => setImmediate(resolve))
    expect(held).toEqual(['recollect']) // ask() 还没 resolve,token 已经在手
    expect(released).toEqual([])
    resolveAsk('写完了。')
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    await vi.waitFor(() => expect(released).toEqual(['recollect']))
  })

  /**
   * 终审必判④(b):crossedOvernight 按主人本地时区算,不按 UTC——sink 层
   * 面钉住 timezone 依赖真的被用上,不只是核心函数单测过。matter 在
   * 23:50 UTC 建,现在是 00:10 UTC(次日凌晨)——UTC 日历日翻了,但
   * Asia/Shanghai 本地(UTC+8)仍是同一天上午,不该算 overnight;turns=0
   * 也不够格,整条应该连模型都不问。
   */
  it('crossedOvernight 用的是 timezone 依赖,不是硬编码 UTC(UTC 日历日翻了但本地没翻,不该够格)', async () => {
    matters.create({id: 'c0000004', kind: 'task', title: '跨零点但本地没跨天'})
    db.query('UPDATE matters SET created_at=? WHERE id=?').run(Date.parse('2026-09-23T23:50:00.000Z'), 'c0000004')
    const cheapEval = vi.fn(async () => '不该被问到')
    const sink = makeRecollectSink({matters, journal, timezone: () => 'Asia/Shanghai', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => Date.parse('2026-09-24T00:10:00.000Z'), log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger('c0000004', 0)
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  /**
   * 终审必判④(a)的事实陈述措辞:prompt 里的 elapsedHours 是 sink 自己算
   * 的(now - matter.createdAt),不是随便传一个数——这条钉住算出来的小
   * 时数确实进了 prompt,不是"跨了一夜"这种断言式措辞。
   */
  it('overnight 够格时,prompt 里的"相隔约 N 小时"用的是 sink 自己算出来的 elapsedHours', async () => {
    const asked: string[] = []
    const cheapEval = vi.fn(async (prompt: string) => { asked.push(prompt); return '写完了。' })
    // matter 建于 DAY1(2026-09-23T10:00 UTC),now 是 DAY1 + 15 小时(次日
    // 01:00 UTC)——确保真的跨了 UTC 日历日,overnight 才会是 true。
    const nowMs = DAY1 + 15 * 3_600_000
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => nowMs, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 0) // turns 不够格,靠 overnight 单独撑起来才会问——先确认这组输入确实会问
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    expect(asked[0]).not.toContain('跨了一夜')
    expect(asked[0]).toMatch(/交办与答复不在同一天,相隔约 \d+ 小时/)
  })

  /**
   * 终审「小的」:cheapEval 卡住(agy 的 --print-timeout 上界 600s)时,不
   * 能让 holdBusy 的 token 跟着卡满十分钟、daemon 十分钟不空闲不自动重
   * 启,而且没有任何日志说为什么。套上 cheapEvalBudgetMs 超时之后,卡住
   * 的调用会在预算到点时被当成真的失败处理(留痕),不是无限期挂起。
   */
  it('cheapEval 卡住超过预算(cheapEvalBudgetMs):当成真的调用失败留痕,不无限期挂起、不无限期占着 busy token', async () => {
    const hung = new Promise<string>(() => {}) // 永不 resolve,模拟卡住的 agy --print
    const cheapEval = vi.fn(() => hung)
    const released: string[] = []
    const holdBusy = (label: string) => () => { released.push(label) }
    const sink = makeRecollectSink({matters, journal, timezone: () => 'UTC', cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l]), holdBusy, cheapEvalBudgetMs: () => 5})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('recollect_ask_timeout'))).toBe(true))
    expect(journal.list()).toEqual([])
    await vi.waitFor(() => expect(released).toEqual(['recollect'])) // busy token 没有跟着卡住的调用一起挂起
  })
})
