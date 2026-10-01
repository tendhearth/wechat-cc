// 通用链接 / App Links(spec 2026-10-01-tendhearth-pairing-ux §6.2):系统相机扫桌面「连接手机」的码 ⇒ 打开 app 的配对确认卡。
// iOS 的 associated-domains 是 entitlement,按 app.config.js 的约定只由插件写;安卓的 intentFilters 是普通配置,由 app.config.js 用这里导出的同一份主机表设置。
// 开发构建(APNs 沙盒)多认 staging 中继。只覆盖 /pset,别的路径照旧开浏览器。
const { withEntitlementsPlist } = require('expo/config-plugins')

const PROD_HOST = 'relay.tendhearth.com'
const STAGING_HOST = 'relay-staging.tendhearth.com'

const linkHosts = dev => (dev ? [PROD_HOST, STAGING_HOST] : [PROD_HOST])
const associatedDomains = dev => linkHosts(dev).map(h => `applinks:${h}`)
const applyAssociatedDomains = (plist, dev) => ({ ...plist, 'com.apple.developer.associated-domains': associatedDomains(dev) })
const androidIntentFilters = dev => [{
  action: 'VIEW',
  autoVerify: true,
  category: ['BROWSABLE', 'DEFAULT'],
  data: linkHosts(dev).flatMap(host => [{ scheme: 'https', host, path: '/pset' }, { scheme: 'https', host, pathPrefix: '/pset/' }]),
}]

const withAppLinks = (config, { dev = false } = {}) =>
  withEntitlementsPlist(config, c => {
    c.modResults = applyAssociatedDomains(c.modResults, dev)
    return c
  })

module.exports = withAppLinks
module.exports.PROD_HOST = PROD_HOST
module.exports.STAGING_HOST = STAGING_HOST
module.exports.linkHosts = linkHosts
module.exports.associatedDomains = associatedDomains
module.exports.applyAssociatedDomains = applyAssociatedDomains
module.exports.androidIntentFilters = androidIntentFilters
