// 测试用的真 Provider 外壳:真的 BackendProvider(注入假后端 = 网络边界)+ 固定语言。
// 不再 vi.mock('./BackendProvider') / ('../i18n/useLang'):那样测的是「我以为页面怎么拿后端」,接错了照样绿
// (docs/maintainer/verify.md「mock 只许替身系统边界」)。假后端用 makeDemoBackend 打底、按需覆盖几个方法。
// BackendProvider 会用 react-native 的 AppState —— 测试里的 react-native 替身(native-motion.test-support 的
// nativeBoundary)要带上它。
import { Fragment, createElement, type ReactNode } from 'react'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'
import { BackendProvider, useBackendCtx } from './BackendProvider'
import type { Store } from './store'

export type TestCtx = { backend: Backend; store: Store }

/** 把 Provider 内部的那份 { backend, store } 交出来(测试要直接摆弄 store 时用)。 */
function Expose({ onCtx }: { onCtx(ctx: TestCtx): void }) {
  const { backend, store } = useBackendCtx()
  onCtx({ backend, store })
  return null
}

export function withLang(lang: Lang, node: ReactNode) {
  return createElement(LangOverrideCtx.Provider, { value: lang }, node)
}

/**
 * node 包进真 Provider。inputScope 照 SessionProvider 的口径传(不传 = 没配对的 'none' 作用域);
 * onCtx 每次渲染都会被叫,拿最新的就行。
 */
export function withProviders(node: ReactNode, opts: { backend: Backend; lang?: Lang; inputScope?: string | null; onCtx?(ctx: TestCtx): void }) {
  const lang = opts.lang ?? 'zh-Hans'
  return withLang(lang, createElement(BackendProvider, {
    backend: opts.backend, lang, pairing: null, onRevoked: () => {},
    ...(opts.inputScope !== undefined ? { inputScope: opts.inputScope } : {}),
    children: createElement(Fragment, null, opts.onCtx ? createElement(Expose, { onCtx: opts.onCtx }) : null, node),
  }))
}
