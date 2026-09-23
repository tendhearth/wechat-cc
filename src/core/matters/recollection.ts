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
