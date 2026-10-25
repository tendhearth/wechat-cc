/**
 * 「定义要用上游的值」的模块(架构终态 A2):知识库、社交、A2A 服务、配对、乙……这几个模块的构造函数要的
 * 是 bootstrap 里才算出来的东西(配置快照、registry、发送口)。`liftModule` 把「拿到上游的值 → 造出这个模块」
 * 包成一个普通的 DaemonModule:开关(enabled)和 init 都用同一份造出来的模块,只造一次。
 *
 * 规矩:造出来的模块名字必须和外面这一层一样;它自己的 needs 必须都写在外面这一层的 needs 里
 * (外面这一层才是容器排序看得见的那个)。不符 ⇒ 抛(编程错误)。
 */
import type { DaemonModule, EnabledCtx } from './container'

export interface LiftOpts {
  name: string
  needs: readonly string[]
  wants?: readonly string[]
  lazy?: readonly string[]
  /** 缺省 true:这一类都是可选子系统,起不来只降级。 */
  optional?: boolean
}

export function liftModule<T>(opts: LiftOpts, make: (up: EnabledCtx) => DaemonModule<T>): DaemonModule<T> {
  let inner: DaemonModule<T> | undefined
  const build = (up: EnabledCtx): DaemonModule<T> => {
    if (inner) return inner
    const m = make(up)
    if (m.name !== opts.name) throw new Error(`modules: lifted '${opts.name}' built a module named '${m.name}'`)
    const missing = [...(m.needs ?? []), ...(m.wants ?? []), ...(m.lazy ?? [])].filter(n => ![...opts.needs, ...(opts.wants ?? []), ...(opts.lazy ?? [])].includes(n))
    if (missing.length) throw new Error(`modules: lifted '${opts.name}' depends on ${missing.join(', ')} — list them on the outer module`)
    inner = m
    return m
  }
  return {
    name: opts.name,
    needs: opts.needs,
    ...(opts.wants ? { wants: opts.wants } : {}),
    ...(opts.lazy ? { lazy: opts.lazy } : {}),
    optional: opts.optional ?? true,
    enabled: (up) => { const m = build(up); return m.enabled ? m.enabled(up) : true },
    init: (ctx) => build(ctx).init(ctx),
  }
}
