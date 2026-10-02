import { Platform } from 'react-native'

// 正文 / 标题字体由 Txt(phoneFont)决定;这里只留代码用的平台等宽。单独成文件,让 type.ts 保持纯逻辑可在 node 下测。
export const monoFamily = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string
