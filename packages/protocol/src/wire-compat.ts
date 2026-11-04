/**
 * wire-compat.ts — 冻结的旧线上字段,一行一个(M6b,设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md「定案」)。
 *
 * src 里只剩「步」一种读形状;老客户端还在读的旧形状留在线上,由 daemon 现算。每一行写清:哪个字段、现在从哪推、
 * 什么时候能删。退休按版本不按日期:App 在握手里报 `build`(messages.ts 的 ClientHello),daemon 记每台设备最近一次的构建号;
 * **近 30 天连过的设备都 ≥ 那一版**才删那一行。桌面随版本走。删行是单独的 PR;`scripts/wire-compat.guard.test.ts` 只许行数变少。
 */
export interface WireCompatRow {
  /** 线上的字段(协议包里的形状名 + 字段)。 */
  field: string
  /** 读的人。 */
  readers: readonly ('app' | 'web' | 'desktop')[]
  /** daemon 现在从哪推出它。 */
  derivedFrom: string
  /** 什么时候删这一行(和字段)。 */
  retireWhen: string
}

export const WIRE_COMPAT: readonly WireCompatRow[] = Object.freeze([
  {
    field: 'Matter.status',
    readers: ['app', 'web'],
    derivedFrom: 'matters.state + archived_at + 最近一轮 matter_turns.status(任务再看 workbench_tasks.status):src/domain/matters/legacy-status.ts',
    retireWhen: '近 30 天连过的设备都 ≥ 改读 Matter.state / archivedAt 的 App 构建(M6f);手机网页改读(M6e)',
  },
  {
    field: 'MatterDetail.events(MatterEvent)',
    readers: ['app', 'web', 'desktop'],
    derivedFrom: '任务 = 步(matter_items)经 workbench.detail().events;对话 = messages 表(正文唯一来源)',
    retireWhen: '线上有了步的读形状、三端改读之后(还没定;M6 只冻结不删)',
  },
  {
    field: 'WorkbenchTaskEvent(/v1/workbench/task)',
    readers: ['desktop'],
    derivedFrom: '步(matter_items)→ 旧事件形状的投影:src/adapters/store/workbench/timeline-events.ts',
    retireWhen: '桌面 ≥ 改读步的那一版(还没定)',
  },
  {
    field: 'CliActivityItem(/m/api/cli/activity、CliSessionRow.now)',
    readers: ['app', 'web'],
    derivedFrom: '终端那件事的步(payload 就是它);会话还没有那件事时解析记录(M6d 删这条退路)',
    retireWhen: '线上有了步的读形状、App 改读之后(还没定)',
  },
  {
    field: 'topic matter/<id>.phase',
    readers: ['app', 'web'],
    derivedFrom: '任务 = 工作台 phase;其余 = Matter.status(同第一行)',
    retireWhen: '与 Matter.status 同一版(M6f)',
  },
] satisfies WireCompatRow[])
