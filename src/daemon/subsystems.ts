/**
 * SubsystemSupervisor — 可选子系统的启动降级边界
 * (spec docs/superpowers/specs/2026-08-17-subsystem-degraded-boot-design.md)。
 *
 * 只包"允许失败"的子系统;核心链(internal-api/bootstrap 核心/pipeline/
 * ilink/polling)保持朴素顺序代码,失败照旧拒绝启动。状态只在内存——
 * 每次启动重新推导,没有陈旧状态;刻意不复用 health/incident-store
 * (那是连接健康的领域模型,Dependency/FailureKind 枚举不适配子系统名)。
 */
export type SubsystemState = 'ok' | 'degraded' | 'off'

export interface SubsystemStatus {
  name: string
  state: SubsystemState
  /** 仅 degraded:err.message 一行摘要;完整 stack 走 log('SUBSYS')。 */
  error?: string
  sinceIso: string
}

export class SubsystemSupervisor {
  private readonly entries = new Map<string, SubsystemStatus>()
  constructor(private readonly log: (tag: string, line: string) => void) {}

  /**
   * 语义(spec §1):fn 抛错 ⇒ degraded + 返回 undefined,绝不外抛;
   * fn 返回 null/undefined ⇒ off(未配置,沿用 "undefined ⇒ 惰性" 约定);
   * 其余 ⇒ ok,原样返回。同名重复 start 是编程错误,直接 throw。
   */
  async start<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    if (this.entries.has(name)) {
      throw new Error(`SubsystemSupervisor: duplicate start('${name}')`)
    }
    const sinceIso = new Date().toISOString()
    try {
      const value = await fn()
      if (value === null || value === undefined) {
        this.entries.set(name, { name, state: 'off', sinceIso })
        return undefined
      }
      this.entries.set(name, { name, state: 'ok', sinceIso })
      return value
    } catch (err) {
      // 保护机制不能成为新的故障源:这个分支只做内存写 + log。
      const message = err instanceof Error ? err.message : String(err)
      this.entries.set(name, { name, state: 'degraded', error: message, sinceIso })
      this.log('SUBSYS', `${name} failed to start — running degraded: ${
        err instanceof Error ? (err.stack ?? message) : message}`)
      return undefined
    }
  }

  statuses(): SubsystemStatus[] { return [...this.entries.values()] }
  degraded(): SubsystemStatus[] { return this.statuses().filter(s => s.state === 'degraded') }
}
