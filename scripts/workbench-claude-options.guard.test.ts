import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchClaudeOptions } from '../src/features/workbench/wire'

// Follow renamed imports, aliases and small option factories, including async
// wrappers: spreading their Promise is legal TypeScript but loses SDK settings.
function missingAwaits(source: string): number[] {
  const file=ts.createSourceFile('options.ts',source,ts.ScriptTarget.Latest,true)
  const factories=new Set(['workbenchClaudeOptions']), nodes: ts.Node[]=[]
  const walk=(node: ts.Node)=>{nodes.push(node);ts.forEachChild(node,walk)};walk(file)
  for(const node of nodes) if(ts.isImportSpecifier(node) && (node.propertyName??node.name).text==='workbenchClaudeOptions') factories.add(node.name.text)
  const unwrap=(node: ts.Node): ts.Node => ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isAwaitExpression(node) ? unwrap(node.expression) : node
  const factoryCall=(node: ts.Node): boolean => {const n=unwrap(node);return ts.isCallExpression(n) && factories.has(unwrap(n.expression).getText(file))}
  let changed=true
  while(changed) {
    changed=false
    const add=(name: string)=>{if(!factories.has(name)){factories.add(name);changed=true}}
    for(const node of nodes) {
      if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer) {
        const value=unwrap(node.initializer)
        if(factories.has(value.getText(file))) add(node.name.text)
        if((ts.isArrowFunction(value)||ts.isFunctionExpression(value))&&(!ts.isBlock(value.body)?factoryCall(value.body):value.body.statements.some(s=>ts.isReturnStatement(s)&&s.expression&&factoryCall(s.expression)))) add(node.name.text)
      }
      if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamespaceImport(node.importClause.namedBindings)) add(`${node.importClause.namedBindings.name.text}.workbenchClaudeOptions`)
      if(ts.isFunctionDeclaration(node)&&node.name&&node.body?.statements.some(s=>ts.isReturnStatement(s)&&s.expression&&factoryCall(s.expression))) add(node.name.text)
    }
  }
  return nodes.filter(ts.isCallExpression).filter(node=>factories.has(unwrap(node.expression).getText(file))).filter(node=>{
    let parent: ts.Node=node
    while(ts.isParenthesizedExpression(parent.parent)||ts.isAsExpression(parent.parent)||ts.isSatisfiesExpression(parent.parent)) parent=parent.parent
    return !ts.isAwaitExpression(parent.parent)
  }).map(node=>file.getLineAndCharacterOfPosition(node.getStart(file)).line+1)
}

describe('workbench Claude option preparation is awaited',()=>{
  it('detects direct, renamed, aliased, namespaced and wrapped calls before spreading',()=>{
    expect(missingAwaits('workbenchClaudeOptions()')).toEqual([1])
    expect(missingAwaits("import {workbenchClaudeOptions as build} from './wire'; const alias=build; ({...alias()})")).toEqual([1])
    expect(missingAwaits("import * as wire from './wire'; wire.workbenchClaudeOptions()")).toEqual([1])
    expect(missingAwaits('(workbenchClaudeOptions as typeof workbenchClaudeOptions)()')).toEqual([1])
    expect(missingAwaits("import * as wire from './wire'; const options=wire.workbenchClaudeOptions; ({...options()})")).toEqual([1])
    expect(missingAwaits('const options=async()=>await workbenchClaudeOptions(); ({...options()})')).toEqual([1])
    expect(missingAwaits('const options=async()=>await workbenchClaudeOptions(); ({...(await options())})')).toEqual([])
  })
  it('awaits every production, smoke and test call, including option factories',()=>{
    const failures: string[]=[]
    const scan=(dir: string)=>{
      for(const entry of readdirSync(dir,{withFileTypes:true})) {
        const path=join(dir,entry.name)
        if(entry.isDirectory()) scan(path)
        else if(/\.[cm]?[jt]sx?$/.test(entry.name)&&path!==join('scripts','workbench-claude-options.guard.test.ts')) {
          const source=readFileSync(path,'utf8')
          if(source.includes('workbenchClaudeOptions')) failures.push(...missingAwaits(source).map(line=>`${path}:${line}`))
        }
      }
    }
    scan('src');scan('scripts')
    expect(failures).toEqual([])
  })
  it('[rereview-pdf] final raw SDK options retain the fixture cwd, sandbox wrapper and loopback endpoint',async()=>{
    const source=readFileSync('scripts/workbench-native-attachments-smoke.ts','utf8'),file=ts.createSourceFile('smoke.ts',source,ts.ScriptTarget.Latest,true)
    let expression: ts.Expression|undefined
    const visit=(node: ts.Node)=>{
      if(ts.isCallExpression(node)&&node.expression.getText(file)==='query') {
        const argument=node.arguments[0]
        if(argument&&ts.isObjectLiteralExpression(argument)) for(const property of argument.properties) if(ts.isPropertyAssignment(property)&&property.name.getText(file)==='options') expression=property.initializer
      }
      ts.forEachChild(node,visit)
    };visit(file)
    expect(expression).toBeDefined()
    // Evaluate only the final options expression; never import/run the smoke or SDK.
    const abort=new AbortController(),cwd='/owned-fixture',wrapper='/owned-fixture/sandbox-claude',endpoint='http://127.0.0.1:12345/claude'
    const options=async()=>await workbenchClaudeOptions({cwd,pathToClaudeCodeExecutable:wrapper,env:{ANTHROPIC_API_KEY:'fake-key',ANTHROPIC_BASE_URL:endpoint}},'fixture',async()=>({behavior:'deny',message:'fixture'}))
    const final=await new Function('options','abort',`return (async()=>(${expression!.getText(file)}))()`)(options,abort)
    expect(final.cwd).toBe(cwd)
    expect(final.pathToClaudeCodeExecutable).toBe(wrapper)
    expect(final.env.ANTHROPIC_BASE_URL).toBe(endpoint)
    expect(final.env.ANTHROPIC_API_KEY).toBe('fake-key')
    expect(final.strictMcpConfig).toBe(true)
    expect(final.abortController).toBe(abort)
    expect(final.maxTurns).toBe(1)
  })
})
