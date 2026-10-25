import {describe, expect, it} from 'vitest'
import {claudeModelCatalog, codexModelCatalog, executionModel, readCodexModelCatalog} from './native-model-catalog'

const claude = {value:'native-a',displayName:'Native A',description:'Native description',supportsEffort:true,supportedEffortLevels:['low','max']}
const codex = {id:'native-b',model:'native-b',displayName:'Native B',description:'Native description',isDefault:true,defaultReasoningEffort:'deep-native',supportedReasoningEfforts:[{reasoningEffort:'deep-native',description:'Native depth'}],inputModalities:['text','image']}
describe('native model catalog boundary',()=>{
  it('maps Claude advertised efforts without inventing defaults or modalities',()=>{
    expect(claudeModelCatalog([claude,claude])).toEqual({source:'native',models:[{id:'native-a',displayName:'Native A',description:'Native description',reasoningEfforts:['low','max']}]})
    expect(claudeModelCatalog([{...claude,supportsEffort:false,supportedEffortLevels:undefined}]).models[0]!.reasoningEfforts).toEqual([])
  })
  it('keeps Codex open effort names and native configured default',()=>{
    expect(codexModelCatalog([codex],{model:'custom-default'})).toEqual({source:'native',defaultModel:'custom-default',models:[{id:'native-b',displayName:'Native B',description:'Native description',reasoningEfforts:['deep-native'],defaultReasoningEffort:'deep-native',inputModalities:['text','image']}]})
  })
  it('uses the Codex model slug as the selectable execution key when the preset id differs',()=>{
    const catalog=codexModelCatalog([{...codex,id:'picker-preset',model:'native-execution-model'}],{})
    expect(catalog.defaultModel).toBe('native-execution-model')
    expect(catalog.models[0]!.id).toBe('native-execution-model')
    expect(executionModel(catalog,{defaults:'native',model:'native-execution-model',reasoningEffort:'deep-native'})?.id).toBe('native-execution-model')
    expect(()=>executionModel(catalog,{defaults:'native',model:'picker-preset',reasoningEffort:null})).toThrow(/execution_model_unsupported/)
    expect(codexModelCatalog([{...codex,id:'picker-preset'}],{model:'native-b'}).defaultModel).toBe('native-b')
  })
  it.each([undefined,null,'','bad\nmodel','x'.repeat(201)])('rejects a malformed Codex model slug instead of falling back to its preset id',model=>{
    expect(()=>codexModelCatalog([{...codex,model}],{})).toThrow(/model_catalog_invalid/)
  })
  it('deduplicates identical execution slugs and rejects conflicting execution capabilities',()=>{
    expect(codexModelCatalog([codex,{...codex,id:'other-preset'}],{}).models).toHaveLength(1)
    expect(()=>codexModelCatalog([codex,{...codex,id:'other-preset',inputModalities:['text']}],{})).toThrow(/model_catalog_invalid/)
  })
  it.each([null,{},[{...claude,value:''}],[{...claude,supportedEffortLevels:['made-up']}],[{...claude,displayName:'x'.repeat(501)}],Array.from({length:201},()=>claude)])('rejects malformed or oversized Claude catalogs',value=>{
    expect(()=>claudeModelCatalog(value)).toThrow(/model_catalog_invalid/)
  })
  it('rejects conflicting duplicate identities and malformed optional capability data',()=>{
    expect(()=>claudeModelCatalog([claude,{...claude,displayName:'Different'}])).toThrow(/model_catalog_invalid/)
    expect(()=>codexModelCatalog([{...codex,inputModalities:['invented']}],{})).toThrow(/model_catalog_invalid/)
    expect(()=>codexModelCatalog([{...codex,supportedReasoningEfforts:[{reasoningEffort:''}]}],{})).toThrow(/model_catalog_invalid/)
  })
  it('validates efforts against the resolved model and permits unknown default with no explicit effort',()=>{
    const catalog=claudeModelCatalog([claude])
    expect(executionModel(catalog,{defaults:'native',model:null,reasoningEffort:null},'unlisted')).toBeUndefined()
    expect(executionModel(catalog,{defaults:'native',model:'native-a',reasoningEffort:'max'})?.id).toBe('native-a')
    expect(()=>executionModel(catalog,{defaults:'native',model:'unlisted',reasoningEffort:null})).toThrow(/execution_model_unsupported/)
    expect(()=>executionModel(catalog,{defaults:'native',model:null,reasoningEffort:'low'})).toThrow(/execution_model_unknown/)
    expect(()=>executionModel(catalog,{defaults:'native',model:'native-a',reasoningEffort:'high'})).toThrow(/execution_effort_unsupported/)
  })
  it('reads every Codex page, checks cursor loops and requests only bounded configuration',async()=>{
    const calls:unknown[]=[]
    const catalog=await readCodexModelCatalog(async(method,params)=>{
      calls.push({method,params})
      return method==='config/read'?{config:{model:'native-b'}}:{data:[codex],nextCursor:params.cursor?null:'page-2'}
    },'/project')
    expect(catalog.models).toHaveLength(1)
    expect(calls).toEqual([{method:'model/list',params:{limit:100,includeHidden:false}},{method:'model/list',params:{limit:100,includeHidden:false,cursor:'page-2'}},{method:'config/read',params:{cwd:'/project',includeLayers:false}}])
    await expect(readCodexModelCatalog(async()=>({data:[codex],nextCursor:'same'}),'/project')).rejects.toThrow(/model_catalog_invalid/)
  })
})
