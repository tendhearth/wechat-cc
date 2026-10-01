// Expo 默认 metro 配置 + 把 .txt 认作资源:字体的 OFL.txt 必须随包发出(src/ui/font-files.ts)。
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts = [...config.resolver.assetExts, 'txt']

module.exports = config
