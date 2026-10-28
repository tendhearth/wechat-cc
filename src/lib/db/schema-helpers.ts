import type { SqlDatabase as Database } from '../runtime/sqlite'

// 迁移和 db.ts 共用的几样(第三批 3e 从 db.ts 原样搬出来):迁移文件不能 import db.ts(会成环)。
// 三个工作台表的建表语句在 ./migrations/shared-ddl.ts(G1:建表只许在 migrations/ 下面);这里按原名转出,v056–v058 与单测照旧从这里拿。
export { initializeWechatNotificationSchema, initializeArtifactDeliverySchema, initializeApiSessionSchema } from './migrations/shared-ddl'
export function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null
}
