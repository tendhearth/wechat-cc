# 数据库迁移

迁移数组在 `src/lib/db.ts`(`export const migrations`)。

## `user_version` 是**计数**,不是编号

SQLite 的 `PRAGMA user_version` 只记「跑过几条」,从不记「跑过哪几条」。所以**位置就是契约**:某个库写着 21,意思是「这个库上次升级时,数组的第 21 项是什么,它就升到了什么」。

由此得到三条铁律:

1. **只能往数组末尾追加。**
2. **永远不要重排、插入、删除已发布的迁移。**
3. **永远不要原地改写已发布的迁移**(注释可以改,它建出来的东西不能改)。

issue #79 就是这么炸的:一条分支从 v18 的树上切出去,自己编了 v19/v20/v21,而主线那边 v19–v25 早就发出去了;合并时被重编成 v26–v28,于是任何跑过分支版的库拿着自己的「21」去对新的含义,开机就 `no such table: social_relay`。修法是循环前的修复 + 指纹守卫,但**规矩本身才是防线**。

## 加一条新迁移要改的三处测试

1. `src/lib/state-migration.test.ts` —— 里面有一行 `expect(v).toBe(<N>)`,把 N 加一。
2. `src/lib/migration-order.test.ts` —— 指纹表。**别自己算指纹**:跑一次测试,从失败输出里把实际值抄进去(前提是你确信自己只是在末尾追加)。
3. `src/lib/db.test.ts` —— 该套件里跟迁移条数 / 新表相关的断言。

三处漏一处,CI 就会在别的平台上红给你看。

## `foreign_keys` 坑

指纹守卫算的是「跑完 1..n 之后的 schema 文本」,而 `openDb` 在跑迁移之前会 `PRAGMA foreign_keys = ON`。这条 pragma 是**承重的**:SQLite 只有在它打开时,才会在 `ALTER TABLE … RENAME TO` 里顺手改写其他表里的外键。有一条迁移正是用这种 rename 重建表的 —— 少了 pragma,裸内存库最后留下一个指向已消失的临时表的外键,和生产库的 schema 不是同一个东西。

这个坑第一次出现时的表现是「macOS 和 CI 对不上」,看着像平台差异,一路查到直接测 pragma 才现形。改指纹相关代码时先确认 pragma 在。

## 自检

```bash
bun --bun vitest run src/lib/state-migration.test.ts src/lib/migration-order.test.ts src/lib/db.test.ts
npm run test:node -- src/lib/migration-order.test.ts        # 换个运行时再来一遍
```
