import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Positive source boundary: all runtime names must be local or one of these pure builtins.
const pureGlobals=new Set(['Math','TextEncoder','Set','Object','Array','JSON','Number','Boolean','String','undefined','Record','Partial','Pick','Omit','Extract','const'])
function pureViolations(path:URL,text=readFileSync(path,'utf8')):string[]{
  const source=ts.createSourceFile(path.pathname,text,ts.ScriptTarget.Latest,true)
  const host=ts.createCompilerHost({noLib:true,noResolve:true})
  host.getSourceFile=(name)=>name===path.pathname?source:undefined
  const checker=ts.createProgram([path.pathname],{noLib:true,noResolve:true},host).getTypeChecker(),errors:string[]=[]
  const visit=(node:ts.Node)=>{
    if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly)errors.push('runtime import')
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&!node.isTypeOnly)errors.push('runtime export')
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push('dynamic import')
    if(ts.isIdentifier(node)){
      const p=node.parent,isProperty=(ts.isPropertyAccessExpression(p)&&p.name===node)||((ts.isPropertyAssignment(p)||ts.isMethodSignature(p)||ts.isPropertySignature(p))&&p.name===node)
      const symbol=checker.getSymbolAtLocation(node)
      if(!isProperty&&!symbol?.declarations?.some(d=>d.getSourceFile()===source)&&!pureGlobals.has(node.text))errors.push(node.text)
    }
    ts.forEachChild(node,visit)
  };visit(source);return errors
}
function instructionViolations(text:string):string[]{
  const source=ts.createSourceFile('instructions.ts',text,ts.ScriptTarget.Latest,true),errors:string[]=[]
  const imports=new Map([['../../domain/capability-matrix',new Set(['replyTextStrategyFor'])],['../../domain/prompt-builder',new Set(['buildSystemPrompt'])],['../../domain/checkup-persona',new Set(['checkupPersonaText','CheckupPersona'])]])
  const allowedKeys=new Set(['providerId','model','peerProviderId','companionEnabled','delegateAvailable','persona','personaCultivate','conversationActions','replyText'])
  const visit=(node:ts.Node)=>{
    if(ts.isImportDeclaration(node)){
      const allowed=ts.isStringLiteral(node.moduleSpecifier)?imports.get(node.moduleSpecifier.text):undefined
      const names=node.importClause?.namedBindings
      if(!allowed||!names||!ts.isNamedImports(names)||names.elements.some(n=>!allowed.has(n.name.text)||n.propertyName))errors.push('unapproved import')
    }
    if(ts.isCallExpression(node)){
      if(!ts.isIdentifier(node.expression)||!['buildSystemPrompt','checkupPersonaText','replyTextStrategyFor'].includes(node.expression.text))errors.push('unapproved call')
      if(ts.isIdentifier(node.expression)&&node.expression.text==='buildSystemPrompt'){
        const arg=node.arguments[0]
        if(node.arguments.length!==1||!arg||!ts.isObjectLiteralExpression(arg))errors.push('unapproved inputs')
        else for(const p of arg.properties)if(!ts.isPropertyAssignment(p)&&!ts.isShorthandPropertyAssignment(p)||!p.name||!allowedKeys.has(p.name.getText(source)))errors.push('unapproved input')
      }
    }
    ts.forEachChild(node,visit)
  };visit(source)
  // The assembler may only use the four explicit arguments and approved pure imports.
  const body=source.statements.filter(s=>!ts.isImportDeclaration(s)).map(s=>s.getText(source)).join('\n')
  const projected=pureViolations(new URL('checkup-instructions-fixture.ts',import.meta.url),body)
  return [...errors,...projected.filter(x=>!['CheckupPersona','buildSystemPrompt','checkupPersonaText','replyTextStrategyFor'].includes(x))]
}
describe('synthetic checkup privacy boundary',()=>{
  it('allows only type imports and local computations over explicit story/persona inputs',()=>{
    for(const file of ['butler-checkup.ts','checkup-interview.ts','checkup-persona.ts'])expect(pureViolations(new URL(file,import.meta.url)),file).toEqual([])
  })
  it('allows only approved inputs to the pure instruction assembler',()=>{
    const source=readFileSync(new URL('../features/checkup/instructions.ts',import.meta.url),'utf8')
    expect(instructionViolations(source)).toEqual([])
    for(const input of ['curatedMemory','coreMemory','todayDraft','someFuturePrivateInput'])expect(instructionViolations(source.replace('companionEnabled:false',`${input}:persona.name,companionEnabled:false`)),input).not.toEqual([])
    expect(instructionViolations(source.replace('executors}}','executors},...persona}'))).not.toEqual([])
  })
  it('rejects ambient state even under previously unlisted names or dynamic imports',()=>{
    const path=new URL('checkup-fixture.ts',import.meta.url)
    for(const expression of ['global["fetch"]("private")','Deno.env.get("private")','process.env','import("private")'])expect(pureViolations(path,`export const value=${expression}`)).not.toEqual([])
  })
})
