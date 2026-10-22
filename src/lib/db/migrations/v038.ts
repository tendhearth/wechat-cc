import type { Migration } from './types'

// v38 — hunt_catch 加 image_svg:串门回来的明信片(SVG 文本,已 safeSvg)。
// 桌面直接内联渲染(和 portrait.svg 一样);微信收到的是栅格化后的 PNG。
// 同款列存在守卫。
export const migration: Migration = (db) => {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info('hunt_catch')").all()
    if (cols.length === 0 || cols.some(c => c.name === 'image_svg')) return
    db.exec(`ALTER TABLE hunt_catch ADD COLUMN image_svg TEXT;`)
  }
