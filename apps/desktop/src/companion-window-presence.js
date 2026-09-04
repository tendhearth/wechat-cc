// @ts-check
// 浮窗的状态接线:点道具 → 让主窗口露面并切到觅食台(Task 10 的 tauri 命令)。
import { invoke } from './ipc.js'
import { startCompanionPresence } from './companion-presence.js'

// 主窗口切到觅食台会打水位(POST /v1/journal/seen),但浮窗是另一个 webview,
// 要等下一次 20s 轮询才知道 —— 点完包袱还挂在脚边一会儿,看着像没点上。
// 主窗口那边打水位是异步的,所以 settle 之后再宽限 1.5s 才补一次拉取。
const poller = startCompanionPresence({
  onOpenJournal: () => {
    invoke('show_main_window', { page: 'a2a-agents' })
      .catch(err => console.warn('show_main_window failed', err))
      .finally(() => { setTimeout(() => { poller.refresh() }, 1500) })
  },
})
