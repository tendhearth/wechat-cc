/**
 * 文件夹身份 = dev:ino。派发时记下,收集成果 / 截代码快照 / 续接前核对,防项目被移动或替换成别的目录。
 * 从 service.ts 挪出(spec 2026-09-27-workbench-service-split §2:域模块只认 ctx,不 import ../service)。
 */
import { statSync } from 'node:fs'

export function directoryIdentity(path:string):string {
  const stat=statSync(path,{bigint:true})
  if (!stat.isDirectory()) throw new Error('invalid_path')
  return `${stat.dev}:${stat.ino}`
}
