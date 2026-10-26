/**
 * 迁移的顺序只写在这里,一行一个、手写(第三批 3e,设计稿 docs/superpowers/specs/2026-10-23-db-migrations-per-file-design.md)。
 *
 * `PRAGMA user_version` 记的是「跑了几个」,不是哪几个(#79)—— 这张列表的位置就是契约。不扫目录、不按文件名排:
 * 多一个文件不能悄悄变成多一个迁移。第 i 项必须是 `./v{i 补零到三位}`,由 scripts/db-migrations.guard.test.ts 钉住。
 * 加一个迁移:新建下一个编号的文件,在末尾加一行 import 和一项。已经进了 dev 的文件一字不许改(CI 检查),要修就再追加一个。
 */
import type { Migration } from './types'
import { migration as v001 } from './v001'
import { migration as v002 } from './v002'
import { migration as v003 } from './v003'
import { migration as v004 } from './v004'
import { migration as v005 } from './v005'
import { migration as v006 } from './v006'
import { migration as v007 } from './v007'
import { migration as v008 } from './v008'
import { migration as v009 } from './v009'
import { migration as v010 } from './v010'
import { migration as v011 } from './v011'
import { migration as v012 } from './v012'
import { migration as v013 } from './v013'
import { migration as v014 } from './v014'
import { migration as v015 } from './v015'
import { migration as v016 } from './v016'
import { migration as v017 } from './v017'
import { migration as v018 } from './v018'
import { migration as v019 } from './v019'
import { migration as v020 } from './v020'
import { migration as v021 } from './v021'
import { migration as v022 } from './v022'
import { migration as v023 } from './v023'
import { migration as v024 } from './v024'
import { migration as v025 } from './v025'
import { migration as v026 } from './v026'
import { migration as v027 } from './v027'
import { migration as v028 } from './v028'
import { migration as v029 } from './v029'
import { migration as v030 } from './v030'
import { migration as v031 } from './v031'
import { migration as v032 } from './v032'
import { migration as v033 } from './v033'
import { migration as v034 } from './v034'
import { migration as v035 } from './v035'
import { migration as v036 } from './v036'
import { migration as v037 } from './v037'
import { migration as v038 } from './v038'
import { migration as v039 } from './v039'
import { migration as v040 } from './v040'
import { migration as v041 } from './v041'
import { migration as v042 } from './v042'
import { migration as v043 } from './v043'
import { migration as v044 } from './v044'
import { migration as v045 } from './v045'
import { migration as v046 } from './v046'
import { migration as v047 } from './v047'
import { migration as v048 } from './v048'
import { migration as v049 } from './v049'
import { migration as v050 } from './v050'
import { migration as v051 } from './v051'
import { migration as v052 } from './v052'
import { migration as v053 } from './v053'
import { migration as v054 } from './v054'
import { migration as v055 } from './v055'
import { migration as v056 } from './v056'
import { migration as v057 } from './v057'
import { migration as v058 } from './v058'
import { migration as v059 } from './v059'
import { migration as v060 } from './v060'
import { migration as v061 } from './v061'
import { migration as v062 } from './v062'
import { migration as v063 } from './v063'
import { migration as v064 } from './v064'
import { migration as v065 } from './v065'
import { migration as v066 } from './v066'
import { migration as v067 } from './v067'
import { migration as v068 } from './v068'
import { migration as v069 } from './v069'
import { migration as v070 } from './v070'
import { migration as v071 } from './v071'
import { migration as v072 } from './v072'
import { migration as v073 } from './v073'
import { migration as v074 } from './v074'
import { migration as v075 } from './v075'
import { migration as v076 } from './v076'
import { migration as v077 } from './v077'
import { migration as v078 } from './v078'
import { migration as v079 } from './v079'
import { migration as v080 } from './v080'
import { migration as v081 } from './v081'
import { migration as v082 } from './v082'
import { migration as v083 } from './v083'
import { migration as v084 } from './v084'
import { migration as v085 } from './v085'
import { migration as v086 } from './v086'
import { migration as v087 } from './v087'
import { migration as v088 } from './v088'
import { migration as v089 } from './v089'
import { migration as v090 } from './v090'

export type { Migration }

/**
 * Exported for the position guard in migration-order.test.ts, which pins the
 * schema each released version produces. Do not run these directly — use
 * `runMigrations`, which owns the user_version bookkeeping.
 */
export const migrations: Migration[] = [
  v001,
  v002,
  v003,
  v004,
  v005,
  v006,
  v007,
  v008,
  v009,
  v010,
  v011,
  v012,
  v013,
  v014,
  v015,
  v016,
  v017,
  v018,
  v019,
  v020,
  v021,
  v022,
  v023,
  v024,
  v025,
  v026,
  v027,
  v028,
  v029,
  v030,
  v031,
  v032,
  v033,
  v034,
  v035,
  v036,
  v037,
  v038,
  v039,
  v040,
  v041,
  v042,
  v043,
  v044,
  v045,
  v046,
  v047,
  v048,
  v049,
  v050,
  v051,
  v052,
  v053,
  v054,
  v055,
  v056,
  v057,
  v058,
  v059,
  v060,
  v061,
  v062,
  v063,
  v064,
  v065,
  v066,
  v067,
  v068,
  v069,
  v070,
  v071,
  v072,
  v073,
  v074,
  v075,
  v076,
  v077,
  v078,
  v079,
  v080,
  v081,
  v082,
  v083,
  v084,
  v085,
  v086,
  v087,
  v088,
  v089,
  v090,
]
