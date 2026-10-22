import type { Migration } from './types'
import { hasTable } from '../schema-helpers'

// v77 — 一件事从哪个表面来的(2026-10-19):origin_surface 创建时写一次,此后永不更新
// (触发器拦住任何改动,连 NULL → 值也不行)。matter_bindings 记的是「在哪露过面」,不是出生地。
// 旧行保持 NULL,不回填、不猜 —— 界面不撒谎:NULL 就不画来源标记。
// 以后哪个迁移要是重建 matters 表(建新表 + 拷数据),得把 matters_origin_surface_once 一起重建,不然它悄悄没了。
export const migration: Migration = (db) => {
    if(!hasTable(db,'matters'))return
    const columns=db.query<{name:string},[]>('PRAGMA table_info(matters)').all()
    if(!columns.some(column=>column.name==='origin_surface'))db.exec(`ALTER TABLE matters ADD COLUMN origin_surface TEXT CHECK(origin_surface IN ('wechat','desktop','app','web','cli','companion'))`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS matters_origin_surface_once BEFORE UPDATE OF origin_surface ON matters
      WHEN NEW.origin_surface IS NOT OLD.origin_surface
      BEGIN SELECT RAISE(ABORT,'matter_origin_immutable'); END;`)
  }
