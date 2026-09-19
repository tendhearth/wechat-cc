import { join } from 'node:path'

import { globToRegExp } from '../ci-triage'

/**
 * 自改流水线的**禁改清单**。是代码常量,不是配置 —— 能改它的只有人,
 * 而不是「跑在 --dangerously-skip-permissions 下的执行者顺手把护栏拆了」。
 * 所以清单本身(policy.ts)和回滚配方(self-deploy.ts)都在清单里。
 *
 * 分四类:
 *  · 能把二进制发到所有用户机器上的(发版工作流、发版脚本、更新源、签名配置)
 *  · **闸门本身的定义**:`.github/workflows/**`(CI 那道门)和 `package.json`
 *    的 scripts(tests 那道门跑的就是里面的 typecheck / depcheck / test)——
 *    一条 `"test": "true"` 就能让两道闸门同时变成橡皮图章
 *  · 护栏本身(这个文件)
 *  · 出事之后把机器救回来的那条路(self-deploy 的回滚)
 *
 * 见 docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md §流程与闸门 第 4 步。
 */
export const FORBIDDEN_GLOBS: readonly string[] = [
  '.github/workflows/**',
  'package.json',
  'scripts/publish-update*.ts',
  'scripts/update-hosting.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'src/cli/self-change/policy.ts',
  'src/cli/self-deploy.ts',
]

/**
 * 网里挖掉的那几个洞 —— **确切路径,不是通配**。
 *
 * `.github/workflows/ci.yml` 是自改最常要动的那个文件(加一个作业、改一条
 * paths-filter),而它**不**是发版通道:它只决定这次改动自己要过哪些检查,
 * 改坏了下一次 CI 立刻红给人看。整个 `.github/workflows/**` 关死等于自改
 * 永远碰不了自己的测试矩阵;放开整个目录又等于发版工作流没人看着。
 * 所以这里是一张**白名单**,新增一项要人来加。
 */
export const FORBIDDEN_EXCEPTIONS: readonly string[] = [
  '.github/workflows/ci.yml',
]

const FORBIDDEN_RES: readonly RegExp[] = FORBIDDEN_GLOBS.map(globToRegExp)

/** git 的输出(以及人手输进来的路径)规整成仓库根起算的 posix 路径。 */
function normalize(path: string): string {
  let p = path.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  return p
}

/**
 * `changed` 里命中禁改清单的那些(原样返回,方便直接报给主人看)。
 * 非空 ⇒ guard 闸门判 `forbidden_paths`,整条流水线失败。
 *
 * 白名单先看:例外是**确切路径**,只放行它自己 ——
 * `.github/workflows/ci.yml.bak`、`.github/workflows/ci.yml/x` 都不算。
 */
export function forbiddenPaths(changed: readonly string[]): string[] {
  return changed.filter(p => {
    const n = normalize(p)
    if (FORBIDDEN_EXCEPTIONS.includes(n)) return false
    return FORBIDDEN_RES.some(re => re.test(n))
  })
}

/** 配置没写时流水线用的那组值(见 spec §配置;`max_fix_rounds` 等三项只有代码里有)。 */
export const SELF_CHANGE_DEFAULTS = {
  branch: 'dev',
  implement_budget_usd: 20,
  review_budget_usd: 5,
  max_turns: 300,
  max_per_day: 5,
  approval_timeout_h: 24,
  selftest_executor: 'claude',
  selftest_provider: 'claude',
  max_fix_rounds: 2,
  tests_timeout_ms: 20 * 60_000,
  halt_after_fail_streak: 2,
} as const

/**
 * 专用克隆的落脚处。**刻意不在 STATE_DIR 下面** —— 执行者在
 * `--dangerously-skip-permissions` 下跑,不能离 access.json / 钥匙只有一个 `..`;
 * 也不在 tmpdir(克隆要跨次复用,不能被系统清掉)。
 */
export function defaultWorkdir(homeDir: string, platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? join(homeDir, 'Library', 'Caches', 'wechat-cc', 'self-change')
    : join(homeDir, '.cache', 'wechat-cc', 'self-change')
}
