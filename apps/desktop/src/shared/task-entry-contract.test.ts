import {expect,it} from 'vitest'
import {entryFailureKind,entryErrorStatus} from './task-entry-contract.js'
it.each([['git_workspace_source_unsupported',422],['configuration_not_reproducible',422],['git_workspace_configuration_rejected',422],['git_workspace_changed',409],['git_workspace_conflict',409],['git_workspace_needs_recovery',409],['git_workspace_configuration_changed',409],['invalid_execution_mode',400]])('recognizes definitive project admission rejection %s on every creating surface', (code,status)=>{
 expect(entryErrorStatus(String(code))).toBe(status)
 expect(entryFailureKind(String(code),{surface:'phone',method:'POST',status:Number(status)})).toBe('rejected')
 expect(entryFailureKind(String(code),{surface:'desktop',method:'POST'})).toBe('rejected')
 expect(entryFailureKind(String(code),{surface:'phone',method:'GET',status:Number(status)})).toBe('unknown')
})
it.each(['git_timeout','git_unavailable','git_output_limit'])('retains original identity for uncertain allocator error %s',code=>{
 expect(entryFailureKind(code,{surface:'phone',method:'POST',status:503})).toBe('unknown')
})
