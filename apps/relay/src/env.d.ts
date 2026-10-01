declare module '*.html' {
  const html: string
  export default html
}

interface Env {
  ROOM: DurableObjectNamespace
  METRICS?: AnalyticsEngineDataset
  RELAY_VERSION?: string
  RELAY_ENV?: string
  RELAY_DAILY_BYTES?: string
  RELAY_DAILY_PUSHES?: string
  RELAY_LOGIN_TIMEOUT_MS?: string
  APNS_KEY_P8?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
  APNS_HOST?: string
  APNS_SANDBOX_HOST?: string
  FCM_SERVICE_ACCOUNT?: string
  FCM_HOST?: string
  FCM_TOKEN_URL?: string
  /** 安卓 App Links 的签名证书 SHA-256(逗号分隔;Play 应用签名密钥 + 上传 / 内部分发密钥)。secret。 */
  ANDROID_CERT_SHA256?: string
}
