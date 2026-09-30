import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import { makeDemoBackend } from '../backend/demo'
import { makeStore, type Store } from './store'

type Ctx = { backend: Backend; store: Store; resetDemo(): void }
const BackendCtx = createContext<Ctx | null>(null)

// v1 只有演示后端;下一份计划在这里切换真后端。
// 演示后端只建一次(不随语言重建,否则已批准的事项会复活);语言变化只调 setLang 改之后生成的文案。
export function BackendProvider({ children, backend, lang }: { children: ReactNode; backend?: Backend; lang?: Lang }) {
  const value = useMemo<Ctx>(() => {
    const demo = backend ? null : makeDemoBackend({ lang })
    const b = backend ?? demo!
    return { backend: b, store: makeStore(b), resetDemo: () => demo?.reset() }
    // lang 只用于初次创建;后续变化走下面的 setLang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])
  useEffect(() => {
    const b = value.backend as Partial<ReturnType<typeof makeDemoBackend>>
    if (lang && b.setLang) b.setLang(lang)
  }, [value, lang])
  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}
