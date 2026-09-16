/**
 * runtime/sqlite.ts — SQLite 的运行时适配:Bun 上走 `bun:sqlite`,Node 上走 `node:sqlite`。
 *
 * 2026-09-16 定案(见 docs/cc-workbench.md 修订记录):Bun 留,但降级成"可替换的引擎"。
 * 业务代码只认这里的 `SqlDatabase` / `SqlStatement`,不再直接 import `bun:sqlite`
 * (.dependency-cruiser.cjs 的 `bun-builtins-only-in-runtime` 规则把门)。接口按
 * `bun:sqlite` 的形状照抄,242 处 `db.query<T,P>(sql).get(...)` 一个字不用改;Bun 上
 * 返回的就是 Bun 的 Database 本体,零开销。
 *
 * Node 那条路是"出口是真的"的证明:CI 的 node 作业跑核心套件靠它。已知差异都写在
 * NodeDatabase 里:`file:…?mode=ro&immutable=1` 这种 URI 打开退化成 readOnly,
 * `values()` 由 `all()` 映射(列序即对象键序)。
 */

type Bindable = string | bigint | NodeJS.TypedArray | number | boolean | null
export type SqlBinding = Bindable | Record<string, Bindable>
export interface SqlChanges { changes: number; lastInsertRowid: number | bigint }

export interface SqlStatement<ReturnType = unknown, ParamsType extends SqlBinding[] = any[]> {
  all(...params: ParamsType): ReturnType[]
  get(...params: ParamsType): ReturnType | null
  run(...params: ParamsType): SqlChanges
  values(...params: ParamsType): Array<Array<string | bigint | number | boolean | Uint8Array | null>>
  iterate(...params: ParamsType): IterableIterator<ReturnType>
}
type Params<P> = P extends any[] ? P : [P]
export interface SqlTransaction<A extends any[], T> {
  (...args: A): T
  deferred: (...args: A) => T
  immediate: (...args: A) => T
  exclusive: (...args: A) => T
}
export interface SqlDatabase {
  query<ReturnType, ParamsType extends SqlBinding | SqlBinding[]>(sql: string): SqlStatement<ReturnType, Params<ParamsType>>
  prepare<ReturnType, ParamsType extends SqlBinding | SqlBinding[]>(sql: string, params?: ParamsType): SqlStatement<ReturnType, Params<ParamsType>>
  /** 只接 SQL 文本:仓库里没人给 exec 传绑定,Bun 的带绑定形式也照样满足这个签名。 */
  exec(sql: string): unknown
  transaction<A extends any[], T>(insideTransaction: (...args: A) => T): SqlTransaction<A, T>
  close(throwOnError?: boolean): void
}

export interface OpenSqliteOptions { create?: boolean; readonly?: boolean; readwrite?: boolean }
/** 与 `bun:sqlite` 的 `constants` 同值(SQLite 的 SQLITE_OPEN_* 位)。 */
export const SQLITE_OPEN = { READONLY: 0x00000001, READWRITE: 0x00000002, CREATE: 0x00000004, URI: 0x00000040 } as const

export const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** 打开(或建)一个库。`options` 可以是选项对象,也可以是 SQLITE_OPEN_* 位(URI 打开用)。 */
export function openSqlite(filename: string, options?: OpenSqliteOptions | number): SqlDatabase {
  if (isBun()) {
    const {Database} = require('bun:sqlite') as { Database: new (filename?: string, options?: number | OpenSqliteOptions) => SqlDatabase }
    return new Database(filename, options)
  }
  return new NodeDatabase(filename, options)
}

// ───────────────────────── Node ─────────────────────────
// 本机 Node 24 自带 node:sqlite(DatabaseSync / StatementSync)。类型没进 tsconfig 的
// types,这里只声明用到的那几个方法。
interface NodeStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  iterate(...params: unknown[]): IterableIterator<unknown>
}
interface NodeDatabaseSync {
  prepare(sql: string): NodeStatement
  exec(sql: string): void
  close(): void
}

function nodeSqlite(): { DatabaseSync: new (filename: string, options?: { readOnly?: boolean; open?: boolean }) => NodeDatabaseSync } {
  return require('node:sqlite')
}

/** URI 形式的文件名(`file:/x/y.db?mode=ro&immutable=1`)拆成路径 + 只读标志。 */
function parseUri(filename: string, options?: OpenSqliteOptions | number): { path: string; readOnly: boolean } {
  const bits = typeof options === 'number' ? options : 0
  const readOnly = typeof options === 'object' && options ? !!options.readonly : (bits & SQLITE_OPEN.READONLY) !== 0
  if (!filename.startsWith('file:')) return { path: filename, readOnly }
  const url = new URL(filename)
  return { path: decodeURIComponent(url.pathname), readOnly: readOnly || url.searchParams.get('mode') === 'ro' }
}

/** 把 node:sqlite 的绑定形状对齐到 bun:sqlite:命名参数对象里的键带 `$` / `:` / `@` 前缀都认。 */
function normalizeParams(params: unknown[]): unknown[] {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !ArrayBuffer.isView(params[0])) {
    const named: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params[0] as Record<string, unknown>)) named[/^[$:@]/.test(key) ? key : `$${key}`] = value
    return [named]
  }
  return params
}

class NodeStatementAdapter<R, P extends SqlBinding[]> implements SqlStatement<R, P> {
  constructor(private readonly statement: NodeStatement) {}
  all(...params: P): R[] { return this.statement.all(...normalizeParams(params)) as R[] }
  get(...params: P): R | null { return (this.statement.get(...normalizeParams(params)) as R | undefined) ?? null }
  run(...params: P): SqlChanges { const r = this.statement.run(...normalizeParams(params)); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid } }
  values(...params: P): Array<Array<string | bigint | number | boolean | Uint8Array | null>> {
    return this.all(...params).map(row => Object.values(row as Record<string, never>))
  }
  iterate(...params: P): IterableIterator<R> { return this.statement.iterate(...normalizeParams(params)) as IterableIterator<R> }
}

class NodeDatabase implements SqlDatabase {
  private readonly db: NodeDatabaseSync
  private readonly cache = new Map<string, NodeStatement>()
  private depth = 0
  constructor(filename: string, options?: OpenSqliteOptions | number) {
    const { path, readOnly } = parseUri(filename, options)
    this.db = new (nodeSqlite().DatabaseSync)(path, { readOnly })
  }
  query<R, P extends SqlBinding | SqlBinding[]>(sql: string): SqlStatement<R, Params<P>> {
    let statement = this.cache.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.cache.set(sql, statement) }
    return new NodeStatementAdapter<R, Params<P>>(statement)
  }
  prepare<R, P extends SqlBinding | SqlBinding[]>(sql: string): SqlStatement<R, Params<P>> {
    return new NodeStatementAdapter<R, Params<P>>(this.db.prepare(sql))
  }
  exec(sql: string): unknown {
    this.db.exec(sql)
    // DDL 多半从这里过:node:sqlite 的预编译语句记住的是编译时的列表,迁移加了列之后
    // 缓存里的 `SELECT *` 还会按旧列返回(Bun 会自己重编译)。丢掉缓存最省事也最稳。
    this.cache.clear()
    return undefined
  }
  transaction<A extends any[], T>(inside: (...args: A) => T): SqlTransaction<A, T> {
    const wrap = (begin: string) => (...args: A): T => {
      // 嵌套用 SAVEPOINT,和 bun:sqlite 一样可以在事务里再开事务。
      const nested = this.depth > 0, name = `cc_tx_${this.depth}`
      this.db.exec(nested ? `SAVEPOINT ${name}` : begin)
      this.depth++
      try {
        const result = inside(...args)
        this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT')
        return result
      } catch (error) {
        try { this.db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK') } catch { /* already rolled back */ }
        throw error
      } finally { this.depth-- }
    }
    const fn = wrap('BEGIN') as SqlTransaction<A, T>
    fn.deferred = wrap('BEGIN DEFERRED'); fn.immediate = wrap('BEGIN IMMEDIATE'); fn.exclusive = wrap('BEGIN EXCLUSIVE')
    return fn
  }
  close(): void { this.cache.clear(); this.db.close() }
}
