import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Synthetic questions must remain a pure source; no state, environment or file loaders. */
describe('synthetic checkup privacy boundary', () => {
  it('allows only type imports and no runtime I/O, dynamic imports or ambient state access', () => {
    const path = new URL('./butler-checkup.ts', import.meta.url)
    const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const violations: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) violations.push('runtime import')
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) violations.push('runtime re-export')
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push('dynamic import')
      if (ts.isIdentifier(node) && ['require', 'process', 'Bun', 'fetch', 'eval', 'globalThis'].includes(node.text)) violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })
})
