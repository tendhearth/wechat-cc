/**
 * bootstrap 自己起的东西的收尾清单(架构复查 10-21,第三批 3b 的第一步)。
 *
 * 规矩:**谁起谁登记**。在起定时器、开端口、连出站连接的那一行旁边 `teardown.add(...)`,shutdown 在各子系统
 * (LifecycleSet)停完之后倒序跑这张单,跑完才关知识库、db。以前 yi 的 ws 服务端 / 客户端、知识库适配定时器、
 * 空闲清扫三样起了没人停:关机后定时器还会对着关掉的 store / SessionManager 跑,yi 的端口要等进程退出才放。
 */
export interface TeardownStep { tag: string; what: string; stop: () => unknown }

export interface Teardown {
  add(tag: string, what: string, stop: () => unknown): void
  /** 倒序(后起的先停)。 */
  steps(): readonly TeardownStep[]
}

export function makeTeardown(): Teardown {
  const list: TeardownStep[] = []
  return {
    add: (tag, what, stop) => { list.push({ tag, what, stop }) },
    steps: () => [...list].reverse(),
  }
}
