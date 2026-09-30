import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // 测试里把限额调小,好在几十帧内触发;推送主机指向假地址(本地 workerd 连不了 APNs,workerd#4841)。
      miniflare: {
        bindings: {
          RELAY_VERSION: 'test',
          RELAY_DAILY_BYTES: '200000',
          RELAY_DAILY_PUSHES: '3',
          RELAY_LOGIN_TIMEOUT_MS: '10000',
          APNS_HOST: 'https://fake-apns.test',
          APNS_SANDBOX_HOST: 'https://fake-apns-sandbox.test',
          FCM_HOST: 'https://fake-fcm.test',
          FCM_TOKEN_URL: 'https://fake-oauth.test/token',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'], exclude: ['test/e2e/**'] },
})
