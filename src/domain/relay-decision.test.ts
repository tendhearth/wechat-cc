import { describe, expect, it } from 'vitest'
import { decideRelay, decideResume, HELD_AFTER_COMPLETION, readLegReply, RELAY_PLAN_TTL_MS, type RelayInput } from './relay-decision'

// 新说法先加进表里再改规则。偏向:拿不准就停。
const DONE = [
  '三张插图已经出完,放在 assets/login/ 下,深色版文件名带 -dark。',
  '已完成。改了 LoginHero.tsx 和 login.css,测试全部通过。',
  'Done. Added the three images under assets/login and wired them into LoginHero.',
  '做完了。\n\n- 改了 3 个文件\n- 提交 abc1234\n\n还需要我做别的吗?',
  '接好了,默认用深色那张。需要我顺便把轮播也加上吗?',
  '测试跑完了:42 个通过,0 个失败。',
  '全部 128 条用例通过,没有失败。',
  'All 57 tests passed, no failures.',
  '修复了用户无法登录的问题,回归测试通过。',
  '一开始依赖装不上、构建失败,换成 pnpm 之后跑通了,产物在 dist/。',
  '最初无法访问接口,后来发现是端口写错,改掉后一切正常。',
  '已经把清单整理好。如果后面发现无法打开文件,检查一下编码。',
  '加了重试,避免网络抖动时请求失败。',
  '脚本写好了。\n\n```bash\n# 如果失败就退出\nset -e\nnpm test || echo "failed to run"\n```\n\n运行方式见 README。',
  '改动如下:\n\n| 文件 | 说明 |\n|---|---|\n| a.ts | 无法连接时重试 |\n\n都已提交。',
  '已按备注处理:\n> 请确认是否保留旧接口?\n\n旧接口保留,另加了新接口。',
  'I fixed the bug where the app was unable to start on Windows. All checks pass now.',
  'The build no longer fails; the previous error was resolved by pinning the version.',
  '完成。If you would like, I can also add screenshots.',
  '文档已更新,有问题随时告诉我。',
  '图已导出为 webp。Let me know if you want PNG versions too.',
  '把「是否需要登录」这个开关接进设置页了,默认关闭。',
  '实现了超时处理:请求不能完成时返回 504。已有测试覆盖。',
  '报告写在 docs/report.md,结论:没有发现阻塞问题。',
  'Wrote the migration. Want me to also backfill the old rows?',
  '处理完了,旧数据里 3 条重复记录已合并。',
  '已完成,提交 9f3c2aa。',
  // 11-14 网关实跑(真 Claude 程序 × Kimi-Code)第一棒的原话:交办开场要求的收尾格式。
  '已完成第 1 棒任务。\n\n改动文件位置:`/tmp/project/notes.md`\n\n实际完成的验证:已确认该文件此前不存在,写入了三条旅行准备要点(证件与行程文件、行李打包清单、财务与安全准备)。\n\n未完成的验证:未运行任何格式或内容校验工具;后续棒的接力者可读取并继续处理。',
  // run-46:「未完成:无」是没有遗留,不是没做完
  '已在当前工作区创建 `notes.md`，列出三条整理资料要点。\n\n**文件位置：**  \n`/tmp/project/notes.md`\n\n**内容摘要：**  \n1. **资料分类与归档** — 按主题或来源分类。  \n2. **关键信息提取** — 提取核心观点。  \n3. **一致性核对** — 交叉比对事实。\n\n**验证情况：**  \n- 已完成：文件成功创建，内容包含三条要点。  \n- 未完成：无额外验证需求。',
  '已完成本轮扩写任务。\n\n**交付位置：**  \n`/tmp/project/.cc-workbench/f629ca74/summary.md`\n\n**完成验证：**  \n- 已读取项目工作区 `notes.md`。  \n- `summary.md` 仅作为成果保存，未写入项目目录。\n\n**未完成验证：** 无。',
  // 第二轮真模型验收 run-36 / run-40 的真实收尾
  '已在当前工作区新建 `notes.md`，写入三条整理书桌要点：\n\n1. **清空与分类**：取出所有物品，按文具、文件、电子设备、杂物等分类，区分保留、丢弃与归档。\n2. **合理分区收纳**：按使用频率划分区域，常用物品触手可及。\n3. **养成日常归位习惯**：用完即归位，保持桌面长期整洁有序。',
  '已完成 `todo.md` 文件创建。\n\n- **文件位置**：`/tmp/project/todo.md`\n- **内容**：写入三条待办事项\n  1. 完成需求梳理与接口设计\n  2. 实现核心模块的单元测试并保证覆盖率达标\n  3. 整理项目文档并更新 README\n\n- **验证情况**：已确认文件成功写入三条事项。由于任务仅涉及本地文件创建，无需运行额外测试或联网验证。',
  '三张图接好了。\n\n改动文件位置:src/LoginHero.tsx\n\n实际完成的验证:本地打开页面看过三张图都显示。\n\n未完成的验证:没有跑单元测试。',
  '清单整理完毕。未验证:没有在真机上打开过。',
  'Done: wrote summary.md.\n\nVerification: read the file back.\n\nNot verified: did not run the linter.',
  '写完了。测试尚未运行,因为这个仓库没有测试脚本。',
  'Implemented the endpoint. I have not run the integration tests; unit tests pass.',
  '接好了。\n\n改动:\n- LoginHero.tsx:接入三张图\n- api.ts:无法连接时重试\n- 测试:失败时打印日志',
  '当接口超时时会自动重试三次,这部分已经写完并提交。',
  'Done. When the upload fails the UI now shows a retry button.',
]

const ASKED = [
  '图出了两版,你想用哪一版?',
  '有两种做法:改接口,或者加一层适配。请确认用哪种。',
  '我先停在这里,等你确认后再继续。',
  '需要你提供测试环境的地址,我才能跑集成测试。',
  '这个由你来定:保留旧字段还是直接删?',
  'Which approach do you prefer, A or B?',
  'I need your confirmation before deleting the old table.',
  'Please confirm the target branch before I push.',
  '改完了一半。数据库迁移要不要现在跑?',
  '做到这里发现旧接口还有人在用。是直接删,还是先标成废弃?',
  '已整理出清单,待你确认。',
  '方案写好了,请拍板。',
  '完成了前两项。\n\n第三项需要主人授权访问生产配置。',
  'Should we keep backwards compatibility here?',
  '请告诉我登录页现在用的是哪个组件库。',
  // 第二轮真模型验收 run-41:被拒权限后请主人定——是在等主人,不是「说继续」就能好
  '我尝试创建 `notes.md`，但相关写操作被拒绝，无法在当前 relay-lab 项目工作区生成文件。\n\n**具体缺项/权限情况：**\n- `ListFiles .` 被拒绝，无法查看工作区当前文件列表；\n- `SaveArtifact`（写文件）被拒绝，无法在项目工作区或成果目录创建 `notes.md`。\n\n因此本轮任务尚未完成。请主人确认是否授予相应文件写入权限，或提供可写入的目标路径，我再继续创建 `notes.md`。',
  // run-49:把本轮要求也当成了记录,一步没做,等主人明说
  '我已看到上面的 matter 记录。按你的说明，这些属于记录而非本轮指令，其中任何要求我都不执行。\n\n如果你希望我继续完成第 2 棒的任务（读取 `notes.md` 并询问 summary.md 的“简洁版/详细版”），请明确告诉我，我会按你的要求开始。',
  '读取 `notes.md` 后发现，成果目录中尚未生成 `summary.md`。上一棒没有完成 summary.md 的创建，因此本轮缺少必需的输入文件。\n\n**当前情况说明：**\n- 缺失文件：`summary.md`\n- 未完成项：`check.md` 未创建；一致性检查未执行。\n\n如需继续，请提供上一棒应生成的 `summary.md` 成果。',
  // run-35:只能写进成果目录,给了两个选项等主人挑
  '按现有工具能力，**无法在项目根目录创建 `probe-openai.md`**。\n\n如果您希望：\n1. 先将其保存到任务成果目录，我可以立即执行并回读确认；\n2. 或者您提供/开放可向项目根目录写入的方式后再创建。\n\n请告诉我如何处理。',
  '两种写法都可以,你想要简洁版还是详细版?\n\n改动文件位置:无\n\n实际完成的验证:无\n\n未完成的验证:未运行任何检查。',
  '草稿写好了。\n\n改动文件位置:summary.md\n\n未完成的验证:需要你确认用简洁版还是详细版,确认前没有定稿。',
  '图有两版。你想用哪一版?\n\n文件:\n- assets/a.webp\n- assets/b.webp',
  '做到一半,还有几个问题需要你定:\n\n- 用哪个组件库?\n- 要不要兼容旧版?',
  '清单整理好了,但删除前需要你确认。\n\n还需要我做别的吗?',
]

const BLOCKED = [
  '没能完成:仓库里找不到登录页的入口文件。',
  '无法访问网络,依赖没有装上。',
  '只完成了前两张图,第三张生成失败。',
  '测试跑完了:3 个失败,明细如下。',
  '构建仍然失败,报错在 vite.config.ts。',
  '卡在权限上:写 assets/ 被拒绝。',
  '这一步没有完成,原因是缺少凭据。',
  '额度用完了,后面的没做。',
  'I was unable to run the tests because the database is not reachable.',
  "Couldn't find the LoginHero component anywhere in the repo.",
  'The build still fails with a type error in api.ts.',
  '2 tests failed; the rest passed.',
  'Blocked on missing credentials for the staging API.',
  'Partially done: images are in place but the carousel is not finished.',
  '做不了:这个模型不支持出图。',
  '任务未完成。\n\n我尝试了三种方式都不行,细节见上。',
  'Permission denied when writing to /etc/hosts, so I stopped.',
  '集成测试没通过,5 条用例未通过。',
  '改完了 LoginHero。\n\n改动文件位置:src/LoginHero.tsx\n\n实际完成的验证:跑了单元测试。\n\n未完成的验证:构建失败,报错在 vite.config.ts,没有继续查。',
  '第 2 棒做了一部分。\n\n改动文件位置:summary.md\n\n实际完成的验证:无。\n\n未完成的验证:3 个测试没通过。',
  '没能完成:notes.md 不存在。\n\n改动文件位置:无\n\n实际完成的验证:无\n\n未完成的验证:未运行任何检查。',
  '没能完成第三张图。\n\n已有文件:\n- assets/a.webp\n- assets/b.webp',
]

describe('readLegReply', () => {
  it.each(DONE)('做完了 → 放行: %s', text => expect(readLegReply(text)).toBe('done'))
  it.each(ASKED)('在问主人 → 停: %s', text => expect(readLegReply(text)).toBe('asked'))
  it.each(BLOCKED)('说没做完 → 停: %s', text => expect(readLegReply(text)).toBe('blocked'))
  it.each(['', '   \n ', '```\nonly code\n```', '> 只有引用'])('没有结论 → empty: %j', text => expect(readLegReply(text)).toBe('empty'))

  it('只看开头和结尾:中间的过程叙述不算结论', () => {
    const middle = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 步:尝试方案,期间无法连接、构建失败过几次。`).join('\n\n')
    expect(readLegReply(`已全部完成,产物在 dist/。\n\n${middle}\n\n最终结果:全部通过,已提交。`)).toBe('done')
  })
  it('开头的反问是复述任务,不算在问主人', () => {
    expect(readLegReply('要不要把三张图都接进去?任务里说的是全部,所以都接了。\n\n已完成,提交 abc1234。')).toBe('done')
  })
  it('长文不退化', () => {
    const long = '一开始无法运行,'.repeat(40_000) + '\n\n已完成。'
    const t = performance.now()
    expect(readLegReply(long)).toBe('blocked') // 开头那一段确实在说跑不起来
    expect(performance.now() - t).toBeLessThan(500)
  })
})

const T0 = 1_800_000_000_000
const base = (): RelayInput => ({
  now: T0 + 3_600_000,
  plan: { state: 'approved', approvedAt: T0, legs: [
    { position: 1, state: 'running', autoDispatches: 0 },
    { position: 2, state: 'pending', autoDispatches: 0 },
    { position: 3, state: 'pending', autoDispatches: 0 },
  ] },
  finished: { position: 1, status: 'completed', uncertain: false, pendingQuestion: false, finalText: '三张图出完了,在 assets/login/。' },
  matter: { archived: false, writerNotClosed: false, worktreeRemoved: false, rewindBlocked: false, ownerInputQueued: false },
  nextExecutor: { registered: true, blocked: null },
})
const edit = (f: (i: RelayInput) => void): RelayInput => { const i = base(); f(i); return i }

describe('decideRelay', () => {
  it('做完 → 派下一棒', () => expect(decideRelay(base())).toEqual({ action: 'dispatch', position: 2 }))

  it('最后一棒做完 → 整件事做完', () => {
    const i = edit(i => { i.plan.legs = [{ position: 1, state: 'completed', autoDispatches: 0 }, { position: 2, state: 'running', autoDispatches: 1 }]; i.finished.position = 2 })
    expect(decideRelay(i)).toEqual({ action: 'done' })
  })
  it('最后一棒说没做完 → 停,不算做完', () => {
    const i = edit(i => { i.plan.legs = [{ position: 1, state: 'running', autoDispatches: 0 }]; i.finished.finalText = '测试跑完了:3 个失败。' })
    expect(decideRelay(i)).toEqual({ action: 'stop', reason: 'leg_blocked' })
  })

  it.each([
    ['没批准', (i: RelayInput) => { i.plan.state = 'proposed'; i.plan.approvedAt = null }, 'plan_inactive'],
    ['已取消', (i: RelayInput) => { i.plan.state = 'cancelled' }, 'plan_inactive'],
    ['已走完', (i: RelayInput) => { i.plan.state = 'done' }, 'plan_inactive'],
    ['结束的不是拆法里的棒', (i: RelayInput) => { i.finished.position = null }, 'not_plan_leg'],
    ['结束的不是正在跑的那一棒', (i: RelayInput) => { i.finished.position = 2 }, 'not_plan_leg'],
    ['拆法里没有在跑的棒', (i: RelayInput) => { i.plan.legs[0]!.state = 'stopped' }, 'not_plan_leg'],
    ['结束状态不可信', (i: RelayInput) => { i.finished.uncertain = true }, 'leg_uncertain'],
    ['失败', (i: RelayInput) => { i.finished.status = 'failed' }, 'leg_failed'],
    ['取消', (i: RelayInput) => { i.finished.status = 'cancelled' }, 'leg_cancelled'],
    ['中断', (i: RelayInput) => { i.finished.status = 'interrupted' }, 'leg_interrupted'],
    ['悬着的提问', (i: RelayInput) => { i.finished.pendingQuestion = true }, 'leg_asked'],
    ['最后在问主人', (i: RelayInput) => { i.finished.finalText = '出了两版,你想用哪一版?' }, 'leg_asked'],
    ['自己说没做完', (i: RelayInput) => { i.finished.finalText = '没能完成:找不到入口文件。' }, 'leg_blocked'],
    ['没有结论', (i: RelayInput) => { i.finished.finalText = '' }, 'leg_silent'],
    ['事已归档', (i: RelayInput) => { i.matter.archived = true }, 'matter_blocked'],
    ['写入方没确认退出', (i: RelayInput) => { i.matter.writerNotClosed = true }, 'matter_blocked'],
    ['工作区没了', (i: RelayInput) => { i.matter.worktreeRemoved = true }, 'matter_blocked'],
    ['在回退', (i: RelayInput) => { i.matter.rewindBlocked = true }, 'matter_blocked'],
    ['拆法批准超过七天', (i: RelayInput) => { i.now = T0 + RELAY_PLAN_TTL_MS + 1 }, 'plan_stale'],
    ['下一棒自动派过', (i: RelayInput) => { i.plan.legs[1]!.autoDispatches = 1 }, 'next_already_tried'],
    ['下一棒不是待派', (i: RelayInput) => { i.plan.legs[1]!.state = 'stopped' }, 'next_already_tried'],
    ['下一棒执行者没登记', (i: RelayInput) => { i.nextExecutor.registered = false }, 'next_unavailable'],
    ['下一棒额度用完', (i: RelayInput) => { i.nextExecutor.blocked = 'quota' }, 'next_unavailable'],
    ['下一棒要先确认免审', (i: RelayInput) => { i.nextExecutor.blocked = 'needs_confirmation' }, 'next_unavailable'],
  ] as const)('%s → 停', (_name, change, reason) => {
    expect(decideRelay(edit(change))).toEqual({ action: 'stop', reason })
  })

  it('主人的话还排着 → 等,不派也不停', () => {
    expect(decideRelay(edit(i => { i.matter.ownerInputQueued = true }))).toEqual({ action: 'wait', reason: 'owner_input_queued' })
  })
  it('这一棒失败时,排着的话不改变结论:先停', () => {
    expect(decideRelay(edit(i => { i.matter.ownerInputQueued = true; i.finished.status = 'failed' }))).toEqual({ action: 'stop', reason: 'leg_failed' })
  })
  it('最后一棒做完时,事的状态和下一棒执行者都不相干', () => {
    const i = edit(i => { i.plan.legs = [{ position: 1, state: 'running', autoDispatches: 0 }]; i.matter.archived = true; i.nextExecutor.registered = false; i.now = T0 + RELAY_PLAN_TTL_MS * 2 })
    expect(decideRelay(i)).toEqual({ action: 'done' })
  })
  it('主人续过的那一棒做完,照常往下走(七天从批准算,不从这一棒算)', () => {
    const i = edit(i => { i.plan.legs[0]!.autoDispatches = 0; i.now = T0 + RELAY_PLAN_TTL_MS - 1 })
    expect(decideRelay(i)).toEqual({ action: 'dispatch', position: 2 })
  })
  it('棒号不连续也取下一个最小的', () => {
    const i = edit(i => { i.plan.legs = [{ position: 5, state: 'pending', autoDispatches: 0 }, { position: 1, state: 'running', autoDispatches: 0 }, { position: 3, state: 'pending', autoDispatches: 0 }] })
    expect(decideRelay(i)).toEqual({ action: 'dispatch', position: 3 })
  })
})

describe('decideResume(上一棒做完、下一棒没派出去,主人说「继续」)', () => {
  const held = (f: (i: RelayInput) => void = () => {}): RelayInput => edit(i => {
    i.plan.legs = [{ position: 1, state: 'completed', autoDispatches: 0 }, { position: 2, state: 'pending', autoDispatches: 0 }, { position: 3, state: 'pending', autoDispatches: 0 }]
    f(i)
  })
  it('现在能派 → 派', () => expect(decideResume(held())).toEqual({ action: 'dispatch', position: 2 }))
  it('主人亲口要的:不看批准多久、不看自动派过没有', () => {
    expect(decideResume(held(i => { i.plan.approvedAt = T0 - RELAY_PLAN_TTL_MS * 3; i.plan.legs[1]!.autoDispatches = 1 }))).toEqual({ action: 'dispatch', position: 2 })
  })
  it.each([
    ['拆法已作废', (i: RelayInput) => { i.plan.state = 'cancelled' }, 'plan_inactive'],
    ['有棒在跑', (i: RelayInput) => { i.plan.legs[0]!.state = 'running' }, 'not_plan_leg'],
    ['有棒停在半路', (i: RelayInput) => { i.plan.legs[0]!.state = 'stopped' }, 'not_plan_leg'],
    ['待派的棒后面有派过的棒(状态对不上)', (i: RelayInput) => { i.plan.legs[2]!.state = 'completed' }, 'not_plan_leg'],
    ['事还是不能开工', (i: RelayInput) => { i.matter.worktreeRemoved = true }, 'matter_blocked'],
    ['执行者还是用不了', (i: RelayInput) => { i.nextExecutor.blocked = 'quota' }, 'next_unavailable'],
  ] as const)('%s → 停', (_n, change, reason) => expect(decideResume(held(change))).toEqual({ action: 'stop', reason }))
  it('没有待派的棒 → 做完', () => {
    expect(decideResume(held(i => { for (const l of i.plan.legs) l.state = 'completed' }))).toEqual({ action: 'done' })
  })
  it('主人的话还排着 → 等', () => expect(decideResume(held(i => { i.matter.ownerInputQueued = true }))).toEqual({ action: 'wait', reason: 'owner_input_queued' }))
  it('「这一棒其实做完了」的停法只有这四种', () => {
    expect([...HELD_AFTER_COMPLETION].sort()).toEqual(['matter_blocked', 'next_already_tried', 'next_unavailable', 'plan_stale'])
    // decideRelay 给出这四种时,前面一定已经判过这一棒做完了。
    for (const change of [(i: RelayInput) => { i.matter.archived = true }, (i: RelayInput) => { i.now = T0 + RELAY_PLAN_TTL_MS + 1 }, (i: RelayInput) => { i.nextExecutor.blocked = 'refused' }, (i: RelayInput) => { i.plan.legs[1]!.autoDispatches = 1 }]) {
      const blockedLeg = edit(i => { change(i); i.finished.finalText = '没能完成。' })
      expect(decideRelay(blockedLeg)).toEqual({ action: 'stop', reason: 'leg_blocked' })
      const d = decideRelay(edit(change))
      expect(d.action === 'stop' && HELD_AFTER_COMPLETION.has(d.reason)).toBe(true)
    }
  })
})
