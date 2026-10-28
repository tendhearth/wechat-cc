/**
 * 一家执行者在四件事上各靠什么收住(工具级逐个判 / 沙盒 / 收不住),以及由此推出的「访客能不能用」。
 * 纯规则(架构终态 E1):`agent-provider.ts` 转出给老的 import;`provider-policy.ts` 的第 2 条规则读它。
 */
export type Confinement = 'per_tool' | 'sandbox' | 'none'
export interface ToolSurfaceConfinement {
  /** 读工作区以外的文件(主人的私钥、记忆、access.json 都在外面)。 */
  read_outside_workspace: Confinement
  /** 改文件。 */
  fs_write: Confinement
  /** 跑命令。 */
  shell: Confinement
  /** 上网。 */
  network: Confinement
}

/** 访客能不能用:四件事都收得住才行。 */
export function guestSafe(cap: { confines: ToolSurfaceConfinement }): boolean {
  return Object.values(cap.confines).every(c => c !== 'none')
}
