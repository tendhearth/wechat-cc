import Constants from 'expo-constants'

/**
 * 真机验收构建(scripts/device-e2e.ts:TENDHEARTH_UITESTS=1 prebuild,Release 配置 + 沙盒 APNs,JS 打进包里)。
 * 为什么不直接用开发构建:Expo SDK 57 的 Debug 包把 JS 打进包里跑,启动即红屏(「Cannot create devtools websocket connections
 * in embedded environments」),而且 Debug 包会去局域网找 Metro(弹「查找本地网络中的设备」)。
 * 这个标记只由 app.config.js 在 TENDHEARTH_UITESTS=1 时写进 extra;平常的 prebuild / EAS 构建里永远是 false。
 * 打开的只有:自定义 scheme 与 staging 主机的配对链接(与开发构建同一条 JS 链路)、dev-e2e 页。dev-push-key 与开发令牌兜底仍只认 __DEV__。
 */
export const E2E_BUILD: boolean = (Constants.expoConfig?.extra as { e2eBuild?: unknown } | undefined)?.e2eBuild === true
