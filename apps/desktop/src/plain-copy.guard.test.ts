import { readFileSync, readdirSync } from 'node:fs'
import { Window } from 'happy-dom'
import ts from 'typescript'
import { expect, it } from 'vitest'

const jargon = /\b(?:daemon|dashboard)\b/i
const visibleAttributes = ['alt', 'aria-label', 'placeholder', 'title']
const window = new Window({
  settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
})
const parser = new window.DOMParser()

function htmlCopy(html: string): string[] {
  const doc = parser.parseFromString(html, 'text/html')
  for (const node of doc.querySelectorAll('script, style')) node.remove()
  const walker = doc.createTreeWalker(doc, window.NodeFilter.SHOW_TEXT)
  const words: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) words.push(node.textContent ?? '')
  for (const attr of visibleAttributes) {
    for (const node of doc.querySelectorAll(`[${attr}]`)) words.push(node.getAttribute(attr) ?? '')
  }
  return words
}

// Walk only the pieces that can supply display text. Conditions, selectors,
// command arguments and expressions interpolated into a template stay code.
function literals(node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isTemplateExpression(node)) {
    const markup = node.head.text + node.templateSpans.map(span => `…${span.literal.text}`).join('')
    return [markup, ...node.templateSpans.flatMap(span => literals(span.expression))]
  }
  if (ts.isParenthesizedExpression(node)) return literals(node.expression)
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)]
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return [...literals(node.left), ...literals(node.right)]
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return literals(node.right)
  }
  return []
}

it('桌面界面和系统通知使用 CC 的称呼', () => {
  const src = new URL('./', import.meta.url)
  const modules = readdirSync(new URL('modules/', src)).filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))
  const hits = htmlCopy(readFileSync(new URL('index.html', src), 'utf8'))
    .filter(copy => jargon.test(copy)).map(copy => `index.html — ${copy.trim()}`)

  for (const file of ['main.js', 'view.js', 'pet/bridge/presence-map.js', ...modules.map(name => `modules/${name}`)]) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, src), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const check = (node: ts.Node, copy: string) => {
      if (jargon.test(copy)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        hits.push(`${file}:${line + 1} — ${copy.trim()}`)
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) &&
          ['textContent', 'innerText', 'title', 'placeholder'].includes(node.left.name.text) &&
          [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
        for (const copy of literals(node.right)) check(node, copy)
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console') return
        if (ts.isIdentifier(callee) && ['showToast', 'setPending', 'showNote', 'onProgress'].includes(callee.text) && node.arguments[0]) {
          for (const copy of literals(node.arguments[0])) check(node, copy)
        }
        const [command, options] = node.arguments
        if (command && ts.isStringLiteralLike(command) && command.text === 'notify_user' && options && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
                ['title', 'body'].includes(prop.name.text)) {
              for (const copy of literals(prop.initializer)) check(prop, copy)
            }
          }
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) &&
          (file === 'view.js' && ['body', 'headline', 'helper', 'hint', 'label', 'title'].includes(node.name.text) ||
           file === 'pet/bridge/presence-map.js' && node.name.text === 'hint')) {
        for (const copy of literals(node.initializer)) check(node, copy)
      }
      // HTML literals are parsed as markup so class names and data attributes
      // can keep their internal vocabulary, including .dashboard.
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const [markup] = literals(node)
        if (markup && /^\s*<[a-z]/i.test(markup) && (jargon.test(markup) || markup.includes('&'))) {
          for (const copy of htmlCopy(markup)) check(node, copy)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(hits).toEqual([])
})
