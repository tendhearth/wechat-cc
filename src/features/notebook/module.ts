import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeNotebookStore } from '../../adapters/store/notebook-store'
import type { Bootstrap } from '../../daemon/bootstrap'
import { configuredOwnerChatId } from '../../daemon/companion/resolve-admin'
import type { Foundation } from '../../daemon/foundation'
import { loadCompanionConfig } from '../../lib/companion-config'
import { log } from '../../lib/log'
import { ownerLedgerConversation } from '../../lib/matter-ledger-access'
import { notebookFeature } from './index'

export function notebookModule({ stateDir, db }: Foundation) {
  return notebookFeature(ctx => {
    const { registry } = ctx.get<Bootstrap>('bootstrap')
    const ownerChatId = () => configuredOwnerChatId(stateDir)
    return {
      store: makeNotebookStore(db),
      settings: () => loadCompanionConfig(stateDir),
      model: () => registry.getCheapEval({ private: true }),
      isOwner: caller => ownerLedgerConversation(ownerChatId(), caller),
      persona: () => {
        const owner = ownerChatId()
        if (!owner) return ''
        try { return readFileSync(join(stateDir, 'memory', owner, 'persona.md'), 'utf8').slice(0, 300) } catch { return '' }
      },
      log: (count, length) => log('NOTEBOOK', `count=${count} length=${length}`),
    }
  })
}
