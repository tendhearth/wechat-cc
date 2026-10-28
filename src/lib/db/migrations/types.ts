import type { SqlDatabase as Database } from '../../runtime/sqlite'

/**
 * Each migration runs once, in order, when its index is greater than the
 * file's PRAGMA user_version. After it runs we set user_version = index+1.
 * NEVER reorder; NEVER edit a published migration in place — append a new
 * one. Doing otherwise will corrupt every existing user's database.
 */
export type Migration = (db: Database) => void
