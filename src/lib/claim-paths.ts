/**
 * 文件夹占用的两条路径判定(架构终态 E5,从 adapters/workbench 的 scheduler / execution-claims 搬来):两个路径
 * 是不是同一处或互相嵌套、占用比较前先把路径规范成真实路径。放在 lib:要 node:path / node:fs,src/app 的会话管理
 * 不碰 node 内置(depcheck `app-no-node`)又不能经 adapters,同 `random.ts` 的理由。工作台排队、执行占用也用它。
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

function within(parent: string, child: string): boolean {
  const rel=relative(parent,child)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Paths arrive canonicalized; compare components rather than string prefixes. */
export function pathsConflict(a: string, b: string): boolean {
  return within(a,b) || within(b,a)
}

export function canonicalClaimPath(path:string):string {try{return realpathSync(path)}catch{return path}}
