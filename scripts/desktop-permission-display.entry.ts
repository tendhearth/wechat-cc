// Browser bundle entry. Tauri's CSP disallows Zod's optional runtime compilation.
import './desktop-permission-csp'

export { PERMISSION_SNAPSHOT_NOTICE, PermissionDisplaySchema, permissionCwd, permissionDisplay } from '../packages/protocol/src/permission-display'
export {
  normalizePermissionLines, permissionActionZh, permissionLines, permissionPatchLabel,
  permissionRelativePath, resolvePermissionDisplay,
} from '../packages/protocol/src/permission-presentation'
