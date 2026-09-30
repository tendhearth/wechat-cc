import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import { makeDemoBackend } from '../backend/demo'
import { clearDrafts } from './drafts'
import { makeStore, type Store } from './store'

type Ctx = { backend: Backend; store: Store; resetDemo(): void }
const BackendCtx = createContext<Ctx | null>(null)

// v1 只有演示后端;下一份计划在这里切换真后端。
// 演示后端只建一次(不随语言重建,否则已批准的事项会复活);语言变化只调 setLang 改之后生成的文案。
export function BackendProvider({ children, backend, lang }: { children: ReactNode; backend?: Backend; lang?: Lang }) {
  const value = useMemo<Ctx>(() => {
    const demo = backend ? null : makeDemoBackend({ lang })
    const b = backend ?? demo!
    return { backend: b, store: makeStore(b), resetDemo: () => { clearDrafts(); demo?.reset() } }
    // lang 只用于初次创建;后续变化走下面的 setLang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])
  // 渲染期就静默换语言,这样按语言分键的查询一挂载就拿到新文案;订阅者的推送放到 effect 里补发。
  const demo = value.backend as Partial<ReturnType<typeof makeDemoBackend>>
  if (lang && demo.setLang) demo.setLang(lang, { silent: true })
  const pushed = useRef(lang)
  useEffect(() => {
    if (pushed.current === lang) return
    pushed.current = lang
    demo.republish?.()
  }, [demo, lang])
  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}
