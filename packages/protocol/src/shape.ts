/**
 * shape.ts — 线上消息用的极小校验器(只有 `parse` / `safeParse`),给 messages.ts 用。
 *
 * 为什么不用 zod:messages.ts 被打进手机网页与公网壳页的 IIFE(browser.ts → client.ts → messages.ts)。
 * 完整版 zod 压缩后约 260 KB,会把整页撑出中继一帧;`zod/mini` 小,但跟完整版 zod 同时进一个
 * `bun build --compile` 的包时初始化顺序会坏(daemon 的 sidecar 两个都要,2026-10-25 实测
 * `undefined is not a constructor`)。这里的消息都是扁平的小对象,十几行组合子就够。
 *
 * 语义跟 zod 对齐到这些消息用得上的程度:类型不对就失败;`object` 只留声明过的键(多余的键丢掉,
 * 同 zod 缺省的 strip);`optional` 的键缺省或 undefined 都行;`int` 要求有限整数;`discriminatedUnion`
 * 按判别键挑分支。线上来的一切都不可信:`safeParse` 永不抛,`parse` 失败抛 `ShapeError`。
 */

export class ShapeError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path || '(root)'}: ${reason}`)
    this.name = 'ShapeError'
  }
}

export type SafeResult<T> = { success: true; data: T } | { success: false; error: ShapeError }

export interface Shape<T> {
  parse(x: unknown): T
  safeParse(x: unknown): SafeResult<T>
  /** 内部:校验并返回(对象会被复制、去掉未声明的键);失败抛 ShapeError。 */
  readonly check: (x: unknown, path: string) => T
}

export type Infer<S> = S extends Shape<infer T> ? T : never

function shape<T>(check: (x: unknown, path: string) => T): Shape<T> {
  return {
    check,
    parse: (x) => check(x, ''),
    safeParse(x) {
      try { return { success: true, data: check(x, '') } } catch (e) {
        return { success: false, error: e instanceof ShapeError ? e : new ShapeError('', String(e)) }
      }
    },
  }
}

const fail = (path: string, reason: string): never => { throw new ShapeError(path, reason) }

export function string(opts: { min?: number } = {}): Shape<string> {
  return shape((x, p) => {
    if (typeof x !== 'string') return fail(p, 'expected string')
    if (opts.min !== undefined && x.length < opts.min) return fail(p, `shorter than ${opts.min}`)
    return x
  })
}

export function int(opts: { min?: number } = {}): Shape<number> {
  return shape((x, p) => {
    if (typeof x !== 'number' || !Number.isInteger(x)) return fail(p, 'expected integer')
    if (opts.min !== undefined && x < opts.min) return fail(p, `less than ${opts.min}`)
    return x
  })
}

export type LiteralShape<L> = Shape<L> & { readonly literalValue: L }
export function literal<const L extends string | number>(v: L): LiteralShape<L> {
  return { ...shape((x, p) => (x === v ? v : fail(p, `expected ${JSON.stringify(v)}`))), literalValue: v }
}

export function oneOf<const L extends string | number>(values: readonly L[]): Shape<L> {
  return shape((x, p) => ((values as readonly unknown[]).includes(x) ? (x as L) : fail(p, `expected one of ${values.join(', ')}`)))
}

export function unknown(): Shape<unknown> {
  return shape((x) => x)
}

export function array<T>(item: Shape<T>): Shape<T[]> {
  return shape((x, p) => (Array.isArray(x) ? x.map((v, i) => item.check(v, `${p}[${i}]`)) : fail(p, 'expected array')))
}

/** 字符串键 → 值(值都过 `value`)。 */
export function record<T>(value: Shape<T>): Shape<Record<string, T>> {
  return shape((x, p) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'expected object')
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(x)) out[k] = value.check(v, `${p}.${k}`)
    return out
  })
}

/** 对象字段的「可以没有」标记(只在 `object({...})` 里用)。 */
export interface Optional<T> { readonly optional: Shape<T> }
export function optional<T>(s: Shape<T>): Optional<T> { return { optional: s } }

type Fields = Record<string, Shape<unknown> | Optional<unknown>>
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type ObjectOf<F extends Fields> = Simplify<
  { [K in keyof F as F[K] extends Optional<unknown> ? never : K]: F[K] extends Shape<infer T> ? T : never } &
  { [K in keyof F as F[K] extends Optional<unknown> ? K : never]?: F[K] extends Optional<infer T> ? T : never }
>

export type ObjectShape<F extends Fields> = Shape<ObjectOf<F>> & { readonly fields: F }

export function object<F extends Fields>(fields: F): ObjectShape<F> {
  const s = shape((x, p) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'expected object')
    const rec = x as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, f] of Object.entries(fields)) {
      const v = rec[k]
      if ('optional' in f) { if (v !== undefined) out[k] = f.optional.check(v, `${p}.${k}`) }
      else out[k] = f.check(v, `${p}.${k}`)
    }
    return out as ObjectOf<F>
  })
  return { ...s, fields }
}

export function union<A, B>(a: Shape<A>, b: Shape<B>): Shape<A | B> {
  return shape((x, p) => {
    try { return a.check(x, p) } catch { /* 试下一个 */ }
    try { return b.check(x, p) } catch { /* 都不对 */ }
    return fail(p, 'no union member matched')
  })
}

type Discriminated<K extends string> = Shape<unknown> & { readonly fields: Record<K, LiteralShape<string>> }

/** 按判别键 `key`(每个分支的那个字段必须是 `literal`)挑分支,只用那一个分支校验。 */
export function discriminatedUnion<K extends string, const S extends readonly Discriminated<K>[]>(key: K, branches: S): Shape<Infer<S[number]>> {
  const byTag = new Map<unknown, Discriminated<K>>()
  for (const b of branches) byTag.set(b.fields[key].literalValue, b)
  return shape((x, p) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'expected object')
    const b = byTag.get((x as Record<string, unknown>)[key])
    return b ? (b.check(x, p) as Infer<S[number]>) : fail(`${p}.${key}`, 'unknown discriminator')
  })
}
