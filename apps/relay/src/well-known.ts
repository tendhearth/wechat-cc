/**
 * iOS 通用链接 / 安卓 App Links 的两份声明(spec 2026-10-01-tendhearth-pairing-ux §6.1)。
 * 只覆盖配对壳页 /pset:系统相机扫桌面「连接手机」的码 ⇒ 打开 Tendhearth app(装了的话),否则照旧开网页壳。
 * 安卓签名指纹不在仓库:Worker secret ANDROID_CERT_SHA256(逗号分隔);没设 ⇒ [](验证失败,浏览器兜底)。
 */
export const APPLE_APP_ID = '9Y6JAPDP7A.com.tendhearth.app'
export const ANDROID_PACKAGE = 'com.tendhearth.app'
const SHA256_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }

export function appleAppSiteAssociation() {
  return { applinks: { details: [{ appIDs: [APPLE_APP_ID], components: [{ '/': '/pset' }, { '/': '/pset/*' }] }] } }
}

export function androidCertFingerprints(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const fp = part.trim().toUpperCase()
    if (SHA256_RE.test(fp) && !out.includes(fp)) out.push(fp)
  }
  return out
}

export function assetLinks(raw: string | undefined) {
  const fps = androidCertFingerprints(raw)
  if (fps.length === 0) return []
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fps },
  }]
}

export function wellKnown(pathname: string, env: { ANDROID_CERT_SHA256?: string }): Response | null {
  if (pathname === '/.well-known/apple-app-site-association') return new Response(JSON.stringify(appleAppSiteAssociation()), { headers: HEADERS })
  if (pathname === '/.well-known/assetlinks.json') return new Response(JSON.stringify(assetLinks(env.ANDROID_CERT_SHA256)), { headers: HEADERS })
  return null
}
