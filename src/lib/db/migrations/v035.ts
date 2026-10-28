import type { Migration } from './types'

// v35 — turn_records 记下这一轮调过哪些工具(只有名字,不含参数)。
//
// WHY(2026-09-02):owner 在微信里问「今天有什么新闻」,bot 答得有名有姓,
// 而记录里只有 `chunks=3 dur=39190ms` —— **看不出这答案是查来的还是模型
// 编的**。我当时差点据此断定「新闻是编的」,幸好去看了 agy 的原始流:它
// 真的调了 search_web、跑了 3.75 秒。信号一直在(tool_call 事件),只是
// 从没有人存下来。日志行已经加了 tools=,但日志会滚动、也不能查 ——
// 落一列才谈得上「回头查某条回答有没有联网」。
//
// 存 JSON 数组文本。**只有名字**:参数里是搜索词、文件路径、消息正文。
// 同款 table-exists 守卫:db.test.ts 有从 user_version=26 起跑的夹具。
//
// 守的是**列存在**,不只是表存在。turn_records 是 v15 建的,而 #79 的修复
// 路径「回退到 v18 再重放 v19+」**不会 drop 它** —— 于是重放到这里时列已经
// 在了,裸 ALTER 会抛 duplicate column name。v32/v33/v34 的 social_* 没这个
// 问题是因为那些表会被修复路径整个 drop 掉。
export const migration: Migration = (db) => {
    const has = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='turn_records'")
      .get()
    if (!has || has.cnt === 0) return
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('turn_records')").all()
    if (cols.some(c => c.name === 'tool_calls')) return
    db.exec(`ALTER TABLE turn_records ADD COLUMN tool_calls TEXT;`)
  }
