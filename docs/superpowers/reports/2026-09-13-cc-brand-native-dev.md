# CC icon and native development connection

## Native workbench connection

The native development client was discovering the normal companion daemon.
Authenticated read-only requests to `/v1/workbench` and `/v1/workbench/attention`
returned 404 there. Both routes returned 200 on the separate workbench development
runtime (7 existing test tasks, 2 providers).

The Rust workbench proxy now accepts `WECHAT_CC_WORKBENCH_STATE_DIR` **in debug
builds only**, matching the browser proxy. It does not redirect companion commands
or modify `WECHAT_STATE_DIR`. Blank/unset values retain normal discovery, and
release builds ignore the development override.

With the separate workbench runtime already running, start native development
from `apps/desktop` with:

```sh
WECHAT_CC_DEV_ROOT="$(git rev-parse --show-toplevel)" \
WECHAT_CC_WORKBENCH_STATE_DIR="$HOME/.claude/channels/wechat-workbench-dev" \
bun run dev
```

The existing companion daemon was not restarted. Tauri was relaunched with the
override. Its development web page at port 4174 successfully displayed the task
list and conversation. Native window inspection could not attach to the bare
debug executable; that browser observation is not claimed as native window QA.

## Icon update

- Editable single-colour vector mark based on CC's front silhouette, using
  negative-space eyes. Frozen models, masks and character frames are unchanged.
- Warm paper app tile, charcoal mark; the header and main navigation use the
  same unframed mark. Existing accessible navigation labels are preserved.
- Rebuilt desktop PNG/ICNS/ICO, iOS full-bleed icons, Android adaptive and
  monochrome layers. `bun run build:icons` reproduces the generated files.
- Review page: `apps/desktop/art/cc-brand/preview.html`, outside frontendDist.
  Inspected on light/dark backgrounds and at 16/24/32/48/64/96 px, plus the actual
  workbench header. Owner visual review is pending.

## Verification

- Rust workbench regression failed before the override was added. Both targeted
  Rust proxy tests pass after it, including exact route/method authorization.
- 4 targeted Vitest files, 81 tests pass: navigation, workbench browser proxy,
  asset references and CC asset kit.
- Repository typecheck and `git diff --check` pass.
- No changes under `apps/desktop/src/assets/pet` or `apps/desktop/art/cc-v1`.
- Native development compiled and is running. No mobile application or installed
  macOS bundle was built; generated mobile icons do not imply platform support.
