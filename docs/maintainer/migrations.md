# 数据库迁移

迁移一版一个文件:`src/lib/db/migrations/v001.ts` … `vNNN.ts`。**顺序只写在一处**:`src/lib/db/migrations/index.ts`,一行一个 import、一行一项,手写(不扫目录、不按文件名排)。`src/lib/db.ts` 只剩 `openDb` / `runMigrations` / #79 的修复,`migrations` 从它转出,外部 import 不变。设计稿:`docs/superpowers/specs/2026-10-23-db-migrations-per-file-design.md`。

## `user_version` 是**计数**,不是编号

SQLite 的 `PRAGMA user_version` 只记「跑过几条」,从不记「跑过哪几条」。所以**位置就是契约**:某个库写着 21,意思是「这个库上次升级时,列表的第 21 项是什么,它就升到了什么」。

由此得到三条铁律:

1. **只能往末尾追加。**
2. **永远不要重排、插入、删除已有的迁移。**
3. **永远不要改已经进了 `dev` 的迁移**(连注释也别动 —— 见下面「冻结」)。要修,就再追加一个。

issue #79 就是这么炸的:一条分支从 v18 的树上切出去,自己编了 v19/v20/v21,而主线那边 v19–v25 早就发出去了;合并时被重编成 v26–v28,于是任何跑过分支版的库拿着自己的「21」去对新的含义,开机就 `no such table: social_relay`。修法是循环前的修复 + 指纹守卫,但**规矩本身才是防线**。

## 加一个迁移

1. 新建下一个编号的文件,比如 `src/lib/db/migrations/v085.ts`:

   ```ts
   import type { Migration } from './types'

   // v85 — <一句话说它做什么、为什么>
   export const migration: Migration = (db) => {
     db.exec(`…`)
   }
   ```

   要用 `hasTable` 之类的就从 `../schema-helpers` import(迁移文件**不能** import `db.ts`,会成环)。

2. 在 `index.ts` 末尾加一行 import(`import { migration as v085 } from './v085'`)和列表里的一项(`  v085,`)。
3. 跑测试(见文末)。`migration-order.test.ts` 的指纹表会红:**别自己算指纹**,确认你只是在末尾追加以后,从失败输出里把实际值抄进去。

守卫 `scripts/db-migrations.guard.test.ts` 会核:文件编号从 001 连续、不跳号不重号、个数等于列表长度;`index.ts` 第 i 项就是 `v{i}`、正是从 `./v{i}` import 的;每个文件只导出一个 `migration`。

**两路同时各加一个 v085**:git 会报同名文件冲突。这是故意的 —— 以前是数组末尾各加一项、git 静默合成 v85 / v86,其中一路的库就跟 #79 一样错位。冲突了:后合的那一路把自己的改成 v086,重抄指纹。

## 冻结:进了 `dev` 就一字不改

主人真机跑的就是 `dev`:一个迁移合进 `dev`、部署一次,就已经在他的库里跑过了。之后再改它,对已经过了那一位的库毫无作用,还会让新库和老库的 schema 悄悄分叉。

CI 作业 `migrations · frozen`(`scripts/migration-frozen.ts`)守这一条:只在 PR 改到 `src/lib/db/migrations/**` 时跑(自改流水线也走 PR);`origin/dev` 上已有的每个 `v*.ts`,这一版里必须还在、一字不差。改了、删了、改名了都红。

**真要改老迁移**(比如一个会让新装崩掉的错):PR 标题带 `[migration-edit]`,描述里写清楚为什么、以及**已经跑过旧版的库怎么办**(通常答案是:老的照旧放着,再追加一个迁移去修存量库)。CI 会放行并列出改了哪几个文件。

## 只修存量库的迁移:指纹守卫看不见

`migration-order.test.ts` 比的是「**新建库**跑完迁移得到的 schema」。一个只修存量库的迁移(比如「表已经被旧版本建出来了,缺一列,补上」)在新建库上是空操作,指纹**完全不变** —— 守卫抓不到它写错了。

v49 / v59 就是这样:v49 用 `CREATE TABLE IF NOT EXISTS` 建表,而某一列是在表已经被某台机器建出来之后才加进那条语句的;对存量库 `IF NOT EXISTS` 是空操作,列永远补不上,工作台一个任务都打不开。v59 追加修复(`hasTable` + `PRAGMA table_info` 判断后 `ALTER`)。

这类迁移要配一条**升级路径测试**:造出旧形状的库,再跑迁移。

## 测试里要一个旧版本的库:从真迁移造

`src/lib/db.test.ts` 的 `migratedTo(n)`:用前 n 个真迁移建库、再把 `user_version` 记成 n。要测「从 v28 升上来」,就 `migratedTo(28)`,往里塞你要的旧数据,再 `runMigrations`。

**别手写一个「声称自己在 vN」的假库**。以前这么干过(假 v9 只有 `sessions` 一张表、假 v26 的 `customer_reviews` 只有 `id` 一列),于是迁移体里长出一批「表在不在」的守卫来迁就这些假库 —— 测的不是用户真正走的那条路。从 v085 起,迁移里再出现「起跑的夹具 / test harness / 单测库」这类为测试让路的说法,守卫会红。

例外要写明理由:要的就是某个真机上出现过的怪形状(六月分支那张缺退避列的 `reminders` 表、#79 的错位签名)时,先 `migratedTo` 到对的位置,再造那一处怪形状,别整个库都手写。

## `foreign_keys` 坑

指纹守卫算的是「跑完 1..n 之后的 schema 文本」,而 `openDb` 在跑迁移之前会 `PRAGMA foreign_keys = ON`。这条 pragma 是**承重的**:SQLite 只有在它打开时,才会在 `ALTER TABLE … RENAME TO` 里顺手改写其他表里的外键。有一条迁移正是用这种 rename 重建表的 —— 少了 pragma,裸内存库最后留下一个指向已消失的临时表的外键,和生产库的 schema 不是同一个东西。`migratedTo` 也先开了它。

这个坑第一次出现时的表现是「macOS 和 CI 对不上」,看着像平台差异,一路查到直接测 pragma 才现形。改指纹相关代码时先确认 pragma 在。

## 自检

```bash
bun --bun vitest run src/lib/state-migration.test.ts src/lib/migration-order.test.ts src/lib/db.test.ts scripts/db-migrations.guard.test.ts
npm run test:node -- src/lib/migration-order.test.ts        # 换个运行时再来一遍
bun scripts/migration-frozen.ts                             # 本机有 origin/dev 时,核「进了 dev 的一字没改」
```
