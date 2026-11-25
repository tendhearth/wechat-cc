// Browser bundle entry. Tauri's CSP disallows Zod's optional runtime compilation.
import './desktop-permission-csp'

export { permissionToolAction } from '../packages/protocol/src/permission-tool-words'
export { permissionWaitingTitle } from '../packages/protocol/src/permission-waiting-title'

export { PERMISSION_SNAPSHOT_NOTICE, PermissionDisplaySchema, permissionCwd, permissionDisplay } from '../packages/protocol/src/permission-display'
export {
  permissionTextSegments, permissionActionZh, permissionEditPreview, permissionLines, permissionOperationSource, permissionPatchLabel,
  PERMISSION_INVISIBLE_NOTICE_ZH, PERMISSION_NO_FINAL_NEWLINE_ZH, PERMISSION_WHITESPACE_NOTICE_ZH,
  permissionRelativePath, resolvePermissionDisplay,
} from '../packages/protocol/src/permission-presentation'
