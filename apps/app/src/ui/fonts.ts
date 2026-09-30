import { Platform } from 'react-native'

// 标题用系统衬线:iOS Georgia,安卓 serif(与 Codex 稿一致)。单独成文件,让 tokens.ts 保持纯逻辑可在 node 下测。
export const serifFamily = Platform.select({ ios: 'Georgia', default: 'serif' }) as string
