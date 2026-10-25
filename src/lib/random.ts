/**
 * 随机 id 的唯一出口:node:crypto 的 randomUUID / randomBytes 原样转出。放在 lib:src/app 不碰 node 内置
 * (depcheck `app-no-node`),用例层要生成 id 就经这里(同 `content-hash.ts` 的理由)。
 */
export { randomBytes, randomUUID } from 'node:crypto'
