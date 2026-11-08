/**
 * AI 输出回归评测 —— daemon 这一半(设计稿 docs/design/2026-10-29-output-eval.md)。一个功能一个目录(架构终态 A3)。
 *
 *  - `runner.ts`:被测的那一下(生产的提示词 / 模型 / 便宜模型;只读档、不批权限、不发微信、不写对话库);
 *  - `routes.ts`:`POST /v1/eval/run`(路由表标了 module: 'output-eval');
 *  - 这个文件:模块清单。它要的东西由同目录的 `module.ts` 从 bootstrap / internal-api 里填。
 * 读样本、判分、写报告在 CLI(src/cli/output-eval.ts),纯规则在 src/domain/output-eval.ts。
 * 可选模块:坏了只降级(只有整合者手动跑它)。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { makeEvalRunner, type EvalRunnerDeps } from './runner'
import { outputEvalRoutes } from './routes'

export type { EvalRunnerDeps } from './runner'

export function outputEvalFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => EvalRunnerDeps }): DaemonModule<void> {
  return {
    name: 'output-eval',
    optional: true,
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      ctx.get<InternalApiLifecycle>('internal-api').mount('output-eval', outputEvalRoutes(makeEvalRunner(o.deps(ctx))))
    },
  }
}
