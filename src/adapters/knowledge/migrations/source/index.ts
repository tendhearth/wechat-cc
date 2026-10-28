/**
 * 知识库 source.db 的迁移顺序,只写在这里(架构终态 G1,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.4)。
 * 规矩和主库一样(docs/maintainer/migrations.md):位置就是契约,只往末尾追加,进了 dev 的文件一字不改。
 */
import type { Migration } from '../../../../lib/db'
import { migration as v001 } from './v001'

export const migrations: readonly Migration[] = [
  v001,
]
