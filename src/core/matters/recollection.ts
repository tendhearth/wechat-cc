/**
 * matters/recollection.ts —— 回忆(spec docs/superpowers/specs/2026-09-23-
 * delegation-report-design.md「回忆」)。CC 自己判断这件事值不值得记住,
 * 值得就自己写一段记述落进伴侣日志(journal),不问主人;主人能删掉
 * (spec 已定 #6:不问、可删)。
 *
 * 判据是故事性,不是产出:顺顺当当做完的事第二天就忘了;反复失败、被打
 * 回、隔夜才通的才记得。代码先算候选信号,够不上门槛的**连便宜模型都不
 * 问**——省的是额度,也是噪音。形状照 companion-plan.ts「冷却到了先问
 * 便宜模型」那条已验证的路:纯函数,I/O(真的问模型、真的落 journal)由
 * 调用方注入。
 *
 * 签名是测试钉死的契约(2026-09-23 delegation-report SDD ledger Ruling
 * R4):`{turns, returned, overnight, ask?, write}`。ask 可空表示没有便宜
 * 模型可用——那种情况下整条跳过,不报错、不留半条。ask() 真的抛错(模型
 * 调用失败,不是"没有模型")要留痕,不能跟"没有模型"混成一种沉默。
 *
 * 纯:不引 daemon、不碰 db、不猜 write 落在哪张表的哪个 kind ——那是调用
 * 方的事(见 journal-store.ts 的 recordRecollection)。
 */

/** 起步阈值,故意保守。spec 说这种数要看真实数据再调 —— 调之前别加新信号。 */
export const STORY_SIGNALS = {
  turns: 2,             // 来回过 ≥2 轮
  returned: 1,          // 或者被打回 / 报错过 ≥1 次
  overnight: true,      // 或者跨过一夜(交办与答复不在同一天)
}

export interface MaybeRecollectInput {
  /** 这件事来回过几轮。 */
  turns: number
  /** 被打回 / 报错过几次。 */
  returned: number
  /** 交办与答复是不是不在同一天。 */
  overnight: boolean
  /** 问便宜模型写这段记述;不给 ⇒ 没有便宜模型可用,整条跳过。 */
  ask?: () => Promise<string>
  /** 模型写完之后落地(通常是 journal 的写入口);只在真的写出东西时调用一次。 */
  write: (text: string) => void
  /** 真的出错时留痕(ask() 抛错)。没模型不算错,不走这条。 */
  log?: (msg: string) => void
}

/**
 * 闸在问之前:够不上门槛,ask 连调用一次都不会发生(断言方式是 ask 的调用
 * 次数为 0,不是看返回值)。够得上门槛才问,问到了才写。
 */
function meetsStoryThreshold(input: Pick<MaybeRecollectInput, 'turns' | 'returned' | 'overnight'>): boolean {
  return (
    input.turns >= STORY_SIGNALS.turns ||
    input.returned >= STORY_SIGNALS.returned ||
    (input.overnight && STORY_SIGNALS.overnight)
  )
}

export async function maybeRecollect(input: MaybeRecollectInput): Promise<void> {
  if (!meetsStoryThreshold(input)) return
  if (!input.ask) return // 没有便宜模型可用:不报错、不留半条。
  let text: string
  try {
    text = await input.ask()
  } catch (err) {
    // 这里是真的出错(模型调用失败),跟"没有模型"不是一回事 —— 必须留痕,
    // 不能悄悄吞掉(这个仓库反复栽在"出了错但没人告诉你"上)。
    input.log?.(`recollect_ask_failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  input.write(text)
}

/**
 * `returned`(被打回 / 报错过几次)目前在全仓没有数据源。已核实过:唯一
 * 沾边的 `permissions.rejectAll`(RunPermissions,workbench/permissions.ts)
 * 是整条 run 收尾时批量拒绝挂起的权限请求,不是"这一轮被打回/报错几次"
 * 的计数;workbench/service.ts 的 `Active` 接口里没有任何字段在记这件事。
 *
 * 这是**显式挂的账**,不是漏掉——不要为它新加记账逻辑(那是另一个任务的
 * 活,见 spec docs/superpowers/specs/2026-09-23-delegation-report-design.md
 * 的「还没定」一节)。daemon 侧接线(src/daemon/recollection/recollect-sink.ts)
 * 只传这个常量,不读任何字段。`recollect-sink.test.ts` 里有一条测试钉住
 * "仅凭这个常量、不接任何数据源,`returned` 这一支永远不会单独把够格的
 * 场景撬开"这个现状——谁哪天接上了真数据源、或者不小心把它接成了别的什
 * 么东西,那条测试要响;等真接上数据源的那天,把这个常量、这条注释和那
 * 条测试一起删。
 */
export const RETURNED_SIGNAL_UNAVAILABLE = 0

/**
 * 交办与答复是不是不在同一天(spec「回忆」的 overnight 信号)。用创建时刻
 * 与现在的**主人本地日历日**比较(终审修复:原来比的是 UTC 日历日——
 * UTC+8 下那条日界线落在本地早上 08:00,不是罕见边界,是每天上午的窗
 * 口,主人上午答复的每一件事都会被误判成"跨了一夜")。人说"不在同一
 * 天"指的就是本地日,UTC 边界只是实现取巧的产物。
 *
 * `timezone` 是 IANA 时区名,来自 companion 配置的 `timezone` 字段(见
 * `daemon/companion/config.ts`,默认取进程本地时区)——跟 `mobile-feed.ts`
 * 的 `dayKey` 同一惯例、同一种 `Intl.DateTimeFormat('en-CA', {timeZone,
 * ...})` 写法(两边各自一份小实现是因为 `core` 不能反向依赖 `daemon`,
 * 不是重复发明;没有新造配置项,复用的是仓库已有的这一个)。
 *
 * 边界上仍然会把"隔了两分钟但刚好跨了本地零点"算成 true——这是有意的简
 * 化,不是 bug:spec 的字面意思是"不在同一天",不是"满 24 小时";而且这
 * 个方向的误判(把边界情况多算成"够格")比反过来(该算的没算上)更安
 * 全,跟"够不上门槛才是真正的风险"这条设计取向一致。
 */
export function crossedOvernight(createdAtMs: number, nowMs: number, timezone: string): boolean {
  return localDayKey(createdAtMs, timezone) !== localDayKey(nowMs, timezone)
}

const localDayFmtCache = new Map<string, Intl.DateTimeFormat>()
/** en-CA 的 short date 恰好是 YYYY-MM-DD(同 `daemon/mobile-feed.ts` 的 `dayFmt` 写法,时区非法时退回 UTC 而不是抛错)。 */
function localDayKey(ms: number, timezone: string): string {
  let fmt = localDayFmtCache.get(timezone)
  if (!fmt) {
    try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
    catch { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }) }
    localDayFmtCache.set(timezone, fmt)
  }
  return fmt.format(new Date(ms))
}

/**
 * 给便宜模型的 prompt。只喂它"够格的理由"和任务标题,不喂完整对话——读
 * 原文需要把 WorkbenchStore 的事件流一路穿到 daemon 侧的 sink,是明显更
 * 大的一块改动;这一轮先把"真的问、真的写"这条线接上,读不读得到原文留
 * 给以后按真实数据调(spec「还没定」)。model 只回一两句像朋友那样会记
 * 住的话,不是任务总结。
 *
 * 结尾那句"没什么可记的就什么都不要输出"(fix round 3,评审必判②)不是
 * 装饰:候选信号本身很粗——非 retained 执行者(agy/cursor-ACP/openai/
 * gemini,全仓没有任何 provider 实现 `steer`,`turnSeq` 结构性地推不
 * 动)turns/returned 恒为 0——不给这句话,模型没有"不写"这个出口,便宜
 * 模型就从过滤器变成了产出器。空输出已经在 recollect-sink.ts 里被当成
 * "它决定不写"处理(latch + 留痕),天然接得上。
 *
 * overnight 那一条理由(终审修复):以前直接告诉模型"跨了一夜才有回
 * 复"——一句断言,而 `crossedOvernight` 只是"不在同一天"这个粗糙信号,
 * 真实情况可能只隔了十分钟(23:50 建、00:10 终态)。改成事实陈述"交办与
 * 答复不在同一天,相隔约 N 小时",把"这算不算故事"的判断交还给模型,不
 * 替它下结论——这样"隔了 20 分钟"这种边界情况,模型看到"约 0 小时"大
 * 概率会自己选择不写,而不是被诱导编一句听起来煞有介事的"跨了一夜"。
 */
export function buildRecollectionPrompt(input: { title: string; turns: number; returned: number; overnight: boolean; elapsedHours: number }): string {
  const reasons: string[] = []
  if (input.turns >= STORY_SIGNALS.turns) reasons.push(`来回了 ${input.turns} 轮`)
  if (input.returned >= STORY_SIGNALS.returned) reasons.push(`被打回或报错过 ${input.returned} 次`)
  if (input.overnight) reasons.push(`交办与答复不在同一天,相隔约 ${Math.max(0, Math.round(input.elapsedHours))} 小时`)
  return [
    `你是 CC 自己,刚做完一件事:「${input.title}」。`,
    `这件事记得住,因为${reasons.length > 0 ? reasons.join('、') : '有点特别'}。`,
    '像朋友之间会记住的那样,写一两句话的记述——不是任务总结,别用"已完成"这类措辞。直接输出这句话本身,不要多余的解释、前后缀或引号包裹。',
    '如果这件事其实没什么可记的,就什么都不要输出。',
  ].join('\n')
}

/**
 * service 侧的可选依赖,注入便于测试;不注入就整条功能不存在(降级路径,
 * 与 opts.matters/opts.log、report.ts 的 `ReportSink` 同一套「可选依赖」
 * 约定)。真正的实现(daemon 侧,src/daemon/recollection/recollect-sink.ts)
 * 只在 workbench/service.ts 的**终态**(`recollectOnce`,execute() 的
 * finally 块提交完 `store.update`/`matterSync` 之后,`status!=='interrupted'`
 * 时)被调用——fix round 3 去掉了 `settleQuiet` 那一处(答复静下来每次都
 * 触发,跟"持久去重、按 matter 只给一条"天生冲突,见 recollectOnce 旁边
 * 的注释)。内部去查 matter(拿标题、算 overnight)、拿便宜模型、调
 * `maybeRecollect`、真的落 journal。
 */
export interface RecollectSink {
  /** `turns` 只能在调用点(终审后修复:`recollectOnce` 的终态调用,不再是 `settleQuiet`——那一处 fix round 3 已经去掉)现读——它是 `Active.turnSeq`,只活在那一轮的运行时里,不落盘,事后查不到。 */
  maybeTrigger(taskId: string, turns: number): void
}
