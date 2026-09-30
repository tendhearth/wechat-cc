export type Scheme = 'light' | 'dark'

// 色值以 Codex 稿为准(docs/design/tendhearth-app-v1)。明暗只是外观,不表示在线离线。
export const palette = {
  light: {
    bg: '#faf8f3',
    card: '#fffdf9',
    ink: '#493e32',
    muted: '#796f63',
    line: '#e4ddd2',
    primary: '#58654c',
    primaryInk: '#ffffff',
    navOnBg: '#f7ead2',
    navOnInk: '#674c2d',
    accentSoft: '#eef0e6',
    warn: '#a4632a',
    ok: '#58654c',
  },
  dark: {
    bg: '#221f1b',
    card: '#2c2823',
    ink: '#f1e9dc',
    muted: '#b5aa9a',
    line: '#403a33',
    primary: '#b9c5a5',
    primaryInk: '#221f1b',
    navOnBg: '#3a3227',
    navOnInk: '#f3d9ad',
    accentSoft: '#34382c',
    warn: '#e0a66a',
    ok: '#b9c5a5',
  },
} as const

export const radius = { card: 20, button: 14, pill: 10 } as const
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const
