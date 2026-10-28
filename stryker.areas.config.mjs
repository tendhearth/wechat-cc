// 变异测试第三份(2026-10-27 第二轮加的):工作台任务生命周期 / 对话协调器的一轮计划 / 回复交付 / 拉消息快车道。
// `bun run test:mutation` 跑完前两份接着跑这份。
//
// 为什么不并进主配置:这几份文件牵连的测试(工作台服务、协调器的五家交付、daemon 接线)和权限那批几乎不重合,
// 并进去主配置的首轮(不变异,跑一遍牵连到的全部测试)要多跑一倍;分开以后改了权限只重跑主配置。
// 只放「判定」那一层(什么时候收工 / 谁能进这一轮 / 发什么、发几条 / 快车道吃不吃这条),不放接线。
import base from './stryker.config.mjs'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    // 工作台:文件夹租约 / 空闲收工 / 回报去重 / 派发泵 / 取消(lifecycle),准入与续接(admission),补充(inputs)
    'src/features/workbench/service/lifecycle.ts',
    'src/features/workbench/service/admission.ts',
    'src/features/workbench/service/inputs.ts',
    // 对话协调器:一轮怎么跑,开跑前一次定完(admit / planTurn)
    'src/app/coordinator/plan.ts',
    // 回复交付:取哪段话、NO_REPLY 算不算数(纯的那半)+ 分条 / 去重 / 附件 / 语音回落(daemon 那半)
    'src/domain/turn-reply.ts',
    'src/daemon/reply-delivery.ts',
    // 拉消息:解析 + 快车道(在等拍板时 y/n 当场放开)
    'src/daemon/poll-loop.ts',
    'src/daemon/permission-answer.ts',
  ],
  htmlReporter: { fileName: 'reports/mutation/areas/index.html' },
  jsonReporter: { fileName: 'reports/mutation/areas/mutation.json' },
  incrementalFile: 'reports/mutation/areas/stryker-incremental.json',
}
