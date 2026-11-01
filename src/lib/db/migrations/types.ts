import type { SqlDatabase as Database } from '../../runtime/sqlite'

/**
 * Each migration runs once, in order, when its index is greater than the
 * file's PRAGMA user_version. After it runs we set user_version = index+1.
 * NEVER reorder; NEVER edit a published migration in place — append a new
 * one. Doing otherwise will corrupt every existing user's database.
 */
export type Migration = ((db: Database) => void) & {
  /**
   * 这一条要重建的、被别的表用外键指着的表(SQLite 改不了 CHECK,只能建新表、搬行、换名)。外键开着时 DROP 父表会先
   * 隐式删行、撞上子表,所以 runner 照 SQLite 官方的 12 步:跑之前关外键,事务里跑完后只对指向这几张表的外键做
   * `foreign_key_check`,有悬空的就整条回滚;最后把外键恢复成原来的开关。别的表本来就有的悬空引用不拦(那不是这一条造成的)。
   */
  withoutForeignKeys?: readonly string[]
}
