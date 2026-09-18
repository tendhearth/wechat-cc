/**
 * api-info — 读 `STATE_DIR/internal-api-info.json`(daemon 起来后写的那份)
 * 并把里面两把钥匙一次取齐。
 *
 * WHY:自维护三件套(`self deploy` / `selftest`)两边各自抄了一遍「读 info
 * 文件 → 按 tokenFilePath / operatorTokenFilePath 再读两个文件 → trim」,
 * 两份抄写已经开始漂移(一份只读 file token,一份两把都读)。这里收成一
 * 个读取口,**只给这两个调用方用** —— 仓里另外几处老读法(doctor / pair /
 * hook / agent / social)各有各的容错口径,不在这轮的搬迁范围里。
 *
 * 失败一律吞成 `null`:调用方要区分的只有「daemon 没在跑 / 信息读不全」与
 * 「读到了」两种情况,具体是文件缺失还是 JSON 坏了对它们没有分支意义。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'

export interface ApiInfo {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string
  /** trusted 档的 file token(健康探测这类窄用途)。 */
  token: string
  /** admin 档、按 routeAllow 逐条放行的 operator token(工作台 / selftest 路由)。 */
  operatorToken: string
  tokenFilePath: string
  operatorTokenFilePath: string
}

/**
 * 读 `<stateDir>/internal-api-info.json` 并把两把 token 读出来。
 * 任何一步缺失/损坏 ⇒ `null`(视同 daemon 没在跑)。
 */
export function readApiInfo(stateDir: string): ApiInfo | null {
  try {
    const infoPath = join(stateDir, 'internal-api-info.json')
    const info = readJsonFile<{ baseUrl?: unknown; tokenFilePath?: unknown; operatorTokenFilePath?: unknown }>(infoPath)
    const baseUrl = typeof info.baseUrl === 'string' ? info.baseUrl : ''
    const tokenFilePath = typeof info.tokenFilePath === 'string' ? info.tokenFilePath : ''
    const operatorTokenFilePath = typeof info.operatorTokenFilePath === 'string' ? info.operatorTokenFilePath : ''
    if (!baseUrl || !tokenFilePath || !operatorTokenFilePath) return null
    return {
      baseUrl,
      token: readFileSync(tokenFilePath, 'utf8').trim(),
      operatorToken: readFileSync(operatorTokenFilePath, 'utf8').trim(),
      tokenFilePath,
      operatorTokenFilePath,
    }
  } catch {
    return null
  }
}
