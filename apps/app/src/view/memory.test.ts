import { describe, it, expect } from 'vitest'
import { memoryImportLine } from './memory'

describe('memoryImportLine', () => {
  it('kind=import ⇒「从 X 导入」(X 取 daemon 给的来源名);拆不出 ⇒「从别的助手导入」', () => {
    expect(memoryImportLine([{ ts: 't', excerpt: '从 ChatGPT 导入', kind: 'import' }], 'zh-Hans')).toBe('从 ChatGPT 导入')
    expect(memoryImportLine([{ ts: 't', excerpt: '从 ChatGPT 导入', kind: 'import' }], 'en')).toBe('Imported from ChatGPT')
    expect(memoryImportLine([{ ts: 't', excerpt: '', kind: 'import' }], 'zh-Hans')).toBe('从别的助手导入')
    expect(memoryImportLine([{ ts: 't', excerpt: 'something else', kind: 'import' }], 'en')).toBe('Imported from another assistant')
  })
  it('不是导入的(老 daemon 不带 kind / 聊天出处 / 以后的新类)⇒ 不画', () => {
    expect(memoryImportLine(undefined, 'zh-Hans')).toBeNull()
    expect(memoryImportLine([], 'zh-Hans')).toBeNull()
    expect(memoryImportLine([{ ts: 't', excerpt: '周五回话' }], 'zh-Hans')).toBeNull()
    expect(memoryImportLine([{ ts: 't', excerpt: '从 X 导入', kind: 'future_kind' }], 'zh-Hans')).toBeNull()
  })
})
