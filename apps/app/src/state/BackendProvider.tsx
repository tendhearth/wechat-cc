import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AppState } from 'react-native'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import type { PairingRecord } from '../net/pairing'
import { rnSocket } from '../net/rn-connect'
import { clearDrafts, pairingScopeKey, setPairingScope } from './drafts'
import { makeStore, type Store } from './store'
import { backendFor, watchConnection } from './wiring'

type Ctx = { backend: Backend; store: Store; resetDemo(): void }
const BackendCtx = createContext<Ctx | null>(null)

const devLog = (l: string) => { if (__DEV__) console.log(`[live] ${l}`) } // 只有错误码与路由键,没有令牌

// 有配对记录 ⇒ 真连接后端;没有 ⇒ 演示后端。换配对(配上 / 解除)就整个换掉后端与 store。
// 演示后端不随语言重建(否则已批准的事项会复活);语言由每次读带上,换语言走 store.setLang。
export function BackendProvider({ children, backend: injected, lang, pairing, onRevoked }: {
  children: ReactNode; backend?: Backend; lang: Lang; pairing: PairingRecord | null; onRevoked(): void
}) {
  const value = useMemo<Ctx>(() => {
    // 换配对 ⇒ 草稿 / 本机回执 / 已回复集合全清(复评:A 电脑的那句不能带到 B 上重试)。同步做,新后端的第一帧就干净。
    setPairingScope(pairingScopeKey(pairing))
    const { backend: b, demo } = backendFor(pairing, { lang, open: rnSocket, log: devLog, ...(injected ? { injected } : {}) })
    return { backend: b, store: makeStore(b, { lang }), resetDemo: () => { clearDrafts(); demo?.reset() } }
    // lang 只用于初次创建;之后走 store.setLang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected, pairing])
  useEffect(() => () => value.backend.dispose(), [value])
  useEffect(() => { value.store.setLang(lang) }, [value, lang])

  // 重连(epoch 前进)⇒ 全部查询重新验证;撤销 ⇒ 让会话清钥匙串(只一次)。
  const revoked = useRef(onRevoked)
  revoked.current = onRevoked
  useEffect(() => watchConnection(value.backend, value.store, () => revoked.current()), [value])

  // 回到前台立刻新握手(iOS 在后台会掐 socket,别等协议客户端的退避);进后台就关。
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') value.backend.setActive(true)
      else if (s === 'background') value.backend.setActive(false)
    })
    return () => sub.remove()
  }, [value])

  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}
