import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

/**
 * Node 作业用的配置(CI `node · core suite`,本地 `node node_modules/.bin/vitest run -c vitest.node.config.ts`)。
 * 同一套单元测试在 Node 24 上跑,是"换运行时的出口是真的"的证明。只排除还留在 Bun.serve 上的
 * WebSocket 服务端(yi-ws-*,Node 没有原生 ws 服务端,见 src/lib/runtime/no-bun-globals.test.ts 白名单)。
 */
export default mergeConfig(base, defineConfig({
  test: {
    // 桌面前端的测试是给 Tauri webview 写的,只在 Bun 上跑;Node 作业只看 src/。
    include: ['src/**/*.test.ts'],
    exclude: [
      ...(base.test?.exclude ?? []),
      'src/daemon/yi-ws-server.test.ts',
      'src/daemon/yi-ws-client.test.ts',
      'src/daemon/yi-e2e.test.ts',
    ],
  },
}))
