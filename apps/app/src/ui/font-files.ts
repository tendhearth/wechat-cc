// useFonts 的参数:键 = RN 里用的家族名(= 文件名去扩展名)。只有 Noto Serif SC Regular(裁决 D1)。
export const FONT_FILES = {
  'NotoSerifSC-Regular': require('../../assets/fonts/NotoSerifSC-Regular.ttf'),
  'THSerif4-Regular': require('../../assets/fonts/THSerif4-Regular.ttf'),
  'THSerif4-Medium': require('../../assets/fonts/THSerif4-Medium.ttf'),
} as const

/** 字体的 SIL OFL 许可证随包发出(OFL 要求再分发时附上;metro.config.js 把 .txt 认作资源)。 */
export const FONT_LICENSE: number = require('../../assets/fonts/OFL.txt')
