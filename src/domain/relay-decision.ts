/**
 * 自动接力:一棒结束后,下一棒该不该派。纯函数,不读库、不调模型。
 *
 * 偏向哪边:拿不准就停。多停一次,主人说一句「继续」;错派一棒,是在没做完的地基上再烧一轮,
 * 而且后面的棒会把错的东西当成前提。所以「明确做完」才派,其余都停在这一棒等主人。
 *
 * 结构信号优先于文字:这一棒的结束状态、有没有悬着的提问、这件事本身能不能再开工,
 * 都先于「它最后那段话怎么说」。文字只在结构上一切正常时才看,而且只看开头和结尾两处——
 * 中间的过程叙述(「一开始跑不起来,后来…」)不是结论。
 */

export type LegReply = 'done' | 'asked' | 'blocked' | 'empty'

export type RelayStop =
  | 'plan_inactive'       // 没批准过、已取消、已走完
  | 'plan_stale'          // 批准太久以前的拆法,不再默认主人还是这个意思
  | 'not_plan_leg'        // 结束的这一棒不是拆法里正在跑的那一棒(主人手动换过人 / 另起了一轮)
  | 'leg_failed' | 'leg_cancelled' | 'leg_interrupted' | 'leg_uncertain'
  | 'leg_asked'           // 这一棒在等主人回话(悬着的提问 / 批准,或最后一段是在问主人)
  | 'leg_blocked'         // 这一棒自己说没做完 / 卡住了 / 有失败
  | 'leg_silent'          // 做完了却没有一句结论:无从判断
  | 'matter_blocked'      // 这件事现在不能再开工(归档、工作区没了、写入方没确认退出、在回退)
  | 'next_unavailable'    // 下一棒的执行者现在用不了
  | 'next_already_tried'  // 下一棒自动派过一次了,不自动派第二次

export type RelayDecision =
  | { action: 'dispatch'; position: number }
  | { action: 'wait'; reason: 'owner_input_queued' }
  | { action: 'stop'; reason: RelayStop }
  | { action: 'done' }

export interface RelayLeg {
  position: number
  /** pending:还没派过;running:派出去了还没结束;completed:结束且放行过;stopped:结束但停在这里 */
  state: 'pending' | 'running' | 'completed' | 'stopped'
  /** 自动派出的次数。主人手动「继续」不算。 */
  autoDispatches: number
}

export interface RelayInput {
  now: number
  plan: { state: 'proposed' | 'approved' | 'cancelled' | 'done'; approvedAt: number | null; legs: RelayLeg[] }
  /** 刚结束的这一轮。position 为 null 表示它不属于拆法里的任何一棒。 */
  finished: {
    position: number | null
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    /** 结束状态不可信(写入方是否退出没确认等)。 */
    uncertain: boolean
    /** 结束时还有没回答的提问或没处理的批准。 */
    pendingQuestion: boolean
    finalText: string
  }
  matter: {
    archived: boolean
    writerNotClosed: boolean
    worktreeRemoved: boolean
    rewindBlocked: boolean
    /** 主人对着这件事说的话还排着没送进去:先让当前这一棒把它处理完。 */
    ownerInputQueued: boolean
  }
  /** 下一棒执行者现在的状态;没有下一棒时忽略。 */
  nextExecutor: { registered: boolean; blocked: null | 'quota' | 'refused' | 'needs_confirmation' | 'unavailable' }
}

/** 批准过的拆法在这之后不再自动往下走:主人多半已经不记得当时同意的是什么。 */
export const RELAY_PLAN_TTL_MS = 7 * 86_400_000
export const RELAY_MAX_LEGS = 6

export function decideRelay(i: RelayInput): RelayDecision {
  const { plan, finished, matter } = i
  if (plan.state !== 'approved' || plan.approvedAt === null) return stop('plan_inactive')
  const current = plan.legs.find(l => l.state === 'running')
  if (finished.position === null || !current || current.position !== finished.position) return stop('not_plan_leg')

  // 这一棒自己的结束状态。
  if (finished.uncertain) return stop('leg_uncertain')
  if (finished.status === 'failed') return stop('leg_failed')
  if (finished.status === 'cancelled') return stop('leg_cancelled')
  if (finished.status === 'interrupted') return stop('leg_interrupted')
  if (finished.pendingQuestion) return stop('leg_asked')

  // 主人刚对这件事说了话还没送进去:那句话是说给当前这一棒的,等它处理完再判。
  if (matter.ownerInputQueued) return { action: 'wait', reason: 'owner_input_queued' }

  const reply = readLegReply(finished.finalText)
  if (reply === 'asked') return stop('leg_asked')
  if (reply === 'blocked') return stop('leg_blocked')
  if (reply === 'empty') return stop('leg_silent')

  const next = plan.legs.filter(l => l.position > current.position).sort((a, b) => a.position - b.position)[0]
  if (!next) return { action: 'done' }

  // 这一棒确实做完了,但下一棒现在派不出去。
  if (matter.archived || matter.writerNotClosed || matter.worktreeRemoved || matter.rewindBlocked) return stop('matter_blocked')
  if (i.now - plan.approvedAt > RELAY_PLAN_TTL_MS) return stop('plan_stale')
  if (next.state !== 'pending' || next.autoDispatches > 0) return stop('next_already_tried')
  if (!i.nextExecutor.registered || i.nextExecutor.blocked !== null) return stop('next_unavailable')
  return { action: 'dispatch', position: next.position }
}

const stop = (reason: RelayStop): RelayDecision => ({ action: 'stop', reason })

/**
 * 这几种停法,这一棒本身是做完了的,只是下一棒没派出去。
 * 接线据此把这一棒记成 completed、把原因挂在下一棒上;主人说「继续」时不是让做完的那位再做一遍,
 * 而是用 decideResume 重新判一次下一棒能不能派。
 */
export const HELD_AFTER_COMPLETION: ReadonlySet<RelayStop> = new Set(['matter_blocked', 'plan_stale', 'next_unavailable', 'next_already_tried'])

/**
 * 主人对一件「上一棒做完、下一棒没派出去」的事说了「继续」。
 * 这是主人此刻亲口要的:不再看批准有多久、不再看这一棒是不是自动派过;
 * 只看现在能不能派——事能不能开工、执行者用不用得了。
 */
export function decideResume(i: Pick<RelayInput, 'plan' | 'matter' | 'nextExecutor'>): RelayDecision {
  const { plan, matter } = i
  if (plan.state !== 'approved' || plan.approvedAt === null) return stop('plan_inactive')
  // 还有在跑或停在半路的棒:那是「续这一棒」,不归这里管。
  if (plan.legs.some(l => l.state === 'running' || l.state === 'stopped')) return stop('not_plan_leg')
  const next = plan.legs.filter(l => l.state === 'pending').sort((a, b) => a.position - b.position)[0]
  if (!next) return { action: 'done' }
  // 待派的棒后面不该有派过的棒:状态对不上就不动。
  if (plan.legs.some(l => l.position > next.position && l.state !== 'pending')) return stop('not_plan_leg')
  if (matter.ownerInputQueued) return { action: 'wait', reason: 'owner_input_queued' }
  if (matter.archived || matter.writerNotClosed || matter.worktreeRemoved || matter.rewindBlocked) return stop('matter_blocked')
  if (!i.nextExecutor.registered || i.nextExecutor.blocked !== null) return stop('next_unavailable')
  return { action: 'dispatch', position: next.position }
}

// ── 读这一棒最后那段话 ─────────────────────────────────────────────────────────

/** 只看开头一段和结尾最后一段正文,各取有限长度。 */
const HEAD_MAX = 400
const TAIL_MAX = 700

/** 做完之后的客气话:问的是「还要不要我多做点」,不是这一棒卡着等答案。 */
const OFFER = /需要我|要不要我|要我(再|继续|顺便|帮|也|把)|是否(需要|要)我|还(需要|要|有)(什么|别的|其他|其它|哪些)|想让我|可以(再)?帮你|有(什么)?(问题|需要)(随时|可以|再|就)|随时(告诉|叫|找)我|let me know if|if you('d| would) like|would you like me to|(do you )?want me to|anything else|shall i|should i (also|go ahead|continue|proceed)|happy to/i

/** 明说在等主人的一个答复。 */
const REQUEST = /请(你|您)?(先)?(确认|告诉我|告知|提供|选择|选一|决定|指定|回复|补充|授权|批准|拍板)|需要(你|您|主人)(来|先|的)?(确认|提供|决定|选择|授权|告诉|拍板|给|回复|批准|同意)|等(你|您|主人)(的)?(确认|回复|决定|拍板|答复|同意|批准)|待(你|您|主人)?(确认|决定|拍板)|由(你|您|主人)(来)?(决定|定|选)|(你|您)来(定|决定|选)|需要(你|您|主人)(来)?(定|定夺|定一下)|waiting (for|on) you|need(s)? your (confirmation|input|decision|approval|answer|go-ahead)|please (confirm|provide|choose|decide|tell me|specify|advise|clarify)|awaiting your/i

/** 同一句里说明问题已经过去了。 */
const RESOLVED = /已(经)?(修复|解决|修好|处理|绕过|绕开|恢复|改好|补上)|修(复|好)了|解决了|处理(好|掉)了|绕(过|开)了|后来|最后|最终|现在(可以|能|已|正常|都)|改(成|用|为).{0,12}(后|之后)|换(成|用).{0,12}(后|之后)|不再|\bfixed\b|\bresolved\b|worked around|now (works|passes|runs|succeeds)|no longer|eventually|in the end/i

/** 假设、预防、举例:说的不是这一棒的现状。 */
const HYPOTHETICAL = /如果|若是|假如|万一|一旦|要是|以免|避免|防止|否则|即使|哪怕|当.{1,24}时|时(返回|会|就|则|自动|重试|提示|报错|抛出|显示|跳转)|\bif\b|^when\b|in case|otherwise|to avoid|even if|unless/i

/** 「没有失败」一类:带着失败字眼的好消息。 */
const NEGATED_FAILURE = /(没有?|无|未|零|0 ?个?)(发现|出现|遇到|产生)?(任何|新的)?(失败|报错|错误|问题|阻塞|冲突)|(失败|报错|错误)(数)?(为|是|:|:)? ?0\b|\bno (new )?(failures|errors|issues|blockers|conflicts)|without (errors|failures|issues)|\b0 (failed|failures|errors|failing)/i

const BLOCKED = new RegExp([
  '(未能|没能|没法|无法|不能|没办法)(够)?(完成|继续|执行|运行|启动|访问|读取|写入|安装|找到|连接|编译|构建|推进|验证|测试|提交|生成|处理|实现|确认|拿到|获取|打开|登录|下载)',
  '做不(了|到|成)|完成不了|进行不下去',
  '(任务|这一步|这一棒|本次|这次|这件事)?(没有完成|未完成|没做完|尚未完成|只(完成|做)了|部分完成|中止了|中断了)',
  '被(拒绝|拦截|阻止|拦下|中断|限流)',
  '卡在|卡住|受阻|权限不足|没有权限|额度(用完|不足|耗尽)',
  '缺少(权限|依赖|凭据|密钥|文件|配置|环境)',
  '[1-9]\\d* ?(个|条|项)?(测试|用例|检查)?(失败|未通过|没通过|不通过)',
  '(失败|未通过)(了)? ?[1-9]\\d* ?(个|条|项)',
  '(测试|构建|编译|安装|提交|部署)(仍然|还是|依然|依旧)?(失败|没过|不过|未通过|报错)',
  "couldn'?t|could not|unable to|failed to|wasn'?t able to|was not able to",
  "(cannot|can'?t|can not) (proceed|continue|complete|access|run|find|finish|install|build|verify|connect)",
  'blocked( by| on)?\\b|permission denied|not (completed|finished|done)\\b|\\bincomplete\\b|partially (done|complete|completed)',
  '[1-9]\\d* (tests? )?(failed|failing|failures)\\b|(tests?|build|compilation|install) (still )?(fails|failed|is failing)',
].join('|'), 'i')

/** 去掉不是「它在说话」的部分:代码、引用、表格行、强调符号。 */
function prose(text: string): string {
  return text.normalize('NFKC')
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n').filter(line => !/^\s*(>|\|)/.test(line)).map(line => line.replace(/^\s*[*+] /, '- ')).join('\n')
    .replace(/[*_#]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

const sentences = (zone: string): string[] => zone.split(/(?<=[。!?;\n])/).map(s => s.trim()).filter(Boolean)
const clauses = (sentence: string): string[] => sentence.split(/[,,、:]/).map(s => s.trim()).filter(Boolean)

function asks(zone: string): boolean {
  for (const s of sentences(zone)) {
    if (OFFER.test(s)) continue
    if (REQUEST.test(s)) return true
    if (/\?\s*$/.test(s)) return true
  }
  return false
}

function reportsBlock(zone: string): boolean {
  for (const s of sentences(zone)) {
    if (RESOLVED.test(s)) continue
    for (const c of clauses(s)) {
      if (HYPOTHETICAL.test(c) || NEGATED_FAILURE.test(c)) continue
      if (BLOCKED.test(c)) return true
    }
  }
  return false
}

/** 纯列表;允许顶上有一行以冒号结尾的短标题(「改动:」「文件:」)。 */
const listOnly = (p: string): boolean => {
  const lines = p.split('\n'), items = /^.{0,20}:$/.test(lines[0]!.trim()) && lines.length > 1 ? lines.slice(1) : lines
  return items.every(line => /^\s*(-|\d+[.)、])\s/.test(line))
}
const offerOnly = (p: string): boolean => sentences(p).every(s => OFFER.test(s))

export function readLegReply(text: string): LegReply {
  const body = prose(text)
  if (!body) return 'empty'
  const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const head = paragraphs[0]!.slice(0, HEAD_MAX)
  // 结尾:从后往前跳过纯列表和纯客气话,落在最后一段正文上。
  // 被跳过的列表里若有问句(「- 用哪个库?」),仍算在问主人;但不拿列表项当「没做完」的证据。
  let at = paragraphs.length - 1
  const trailingLists: string[] = []
  while (at > 0 && (listOnly(paragraphs[at]!) || offerOnly(paragraphs[at]!))) { if (listOnly(paragraphs[at]!)) trailingLists.push(paragraphs[at]!.slice(-TAIL_MAX)); at-- }
  const tail = paragraphs[at]!.slice(-TAIL_MAX)
  // 问主人只算结尾:开头的反问多半是复述任务。
  if (asks(tail) || trailingLists.some(asks)) return 'asked'
  if (reportsBlock(head) || reportsBlock(tail)) return 'blocked'
  return 'done'
}
