/**
 * 「写回的旧话 ⇒ 收回」(markWrittenBack):整理 / 导入时,一条记忆条目的正文等于主人收回过的某句话,就把它记成 retracted。
 * 2026-10 变异基线:三道判断(只看 m: / u: 条目、只看 active、够 MIN_RETRACTED_CHARS 长)各自换掉都不红 ——
 * 换掉第一道,主人原话(o:)会被收回;第二道,已经不是 active 的行会被改状态;第三道,一个短词就能误伤整条记忆。
 */
import { describe, it, expect } from 'vitest'
import { MIN_RETRACTED_CHARS, markWrittenBack, retractedTextSet } from './corrections'

type Row = { key: string; text: string; status: string }

describe('markWrittenBack', () => {
  const retracted = retractedTextSet([
    { text: '主人喜欢喝冰美式' },
    { text: '住在杭州西湖边' },
    { text: '喜欢喝咖啡' },        // 5 个字:短于门槛,不拿来比
    { text: '养了一只狗' + '!' },  // 正好 6 个字
    { text: '这句是占位', kind: 'placeholder' },
  ])

  it('门槛是 6 个字(和 lib/memory-corrections 同值)', () => expect(MIN_RETRACTED_CHARS).toBe(6))

  it('逐行裁决', () => {
    // [行, 裁决后的 status, 为什么]
    const table: Array<[Row, string, string]> = [
      [{ key: 'm:a1', text: '主人喜欢喝冰美式', status: 'active' }, 'retracted', 'CC 整理出的条目写回了收回的话'],
      [{ key: 'u:1', text: '住在杭州西湖边', status: 'active' }, 'retracted', '没编号的条目同样算'],
      [{ key: 'm:a2', text: '  主人喜欢喝\n冰美式 ', status: 'active' }, 'active', '空白不同、规范化后不相等(中间多了空格)'],
      [{ key: 'm:a3', text: '住在杭州西湖边  ', status: 'active' }, 'retracted', '首尾空白规范化后相等'],
      [{ key: 'o:a4', text: '主人喜欢喝冰美式', status: 'active' }, 'active', '主人原话(o:)不是写回,不收'],
      [{ key: 'c:a5', text: '主人喜欢喝冰美式', status: 'active' }, 'active', '墓碑自己(c:)不动'],
      [{ key: 'x:a6', text: '主人喜欢喝冰美式', status: 'active' }, 'active', '认不出的行(x:)不动'],
      [{ key: 'm:a7', text: '主人喜欢喝冰美式', status: 'outdated' }, 'outdated', '不是 active 的行不改状态'],
      [{ key: 'm:a8', text: '主人喜欢喝冰美式', status: 'superseded' }, 'superseded', '不是 active 的行不改状态'],
      [{ key: 'm:a9', text: '喜欢喝咖啡', status: 'active' }, 'active', '短于门槛:一个短词不许误伤'],
      [{ key: 'm:b1', text: '养了一只狗!', status: 'active' }, 'retracted', '正好够门槛'],
      [{ key: 'm:b2', text: '这句是占位', status: 'active' }, 'active', '占位墓碑不进名单'],
      [{ key: 'm:b3', text: '主人喜欢喝热美式', status: 'active' }, 'active', '没收回过'],
    ]
    const out = markWrittenBack(table.map(([r]) => r), retracted)
    expect(out.map(r => r.status)).toEqual(table.map(([, s]) => s))
  })

  it('不动的行原样返回,其余字段保留', () => {
    const rows = [{ key: 'm:a1', text: '主人喜欢喝冰美式', status: 'active', ord: 3 }, { key: 'o:x', text: '别的', status: 'active', ord: 4 }]
    const out = markWrittenBack(rows, retracted)
    expect(out[0]).toEqual({ ...rows[0], status: 'retracted' })
    expect(out[1]).toBe(rows[1])
  })
})
