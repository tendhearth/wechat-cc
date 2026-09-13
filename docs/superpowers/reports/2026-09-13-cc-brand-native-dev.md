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
- Native development compiled and is running. Generated mobile icons do not
  imply that a mobile application has been built or verified.

## Follow-up: native Dock icon cache

Tauri 2.10.3 already sets the development Dock icon from its embedded ICNS.
The existing executable still embedded the previous icon because Cargo watched
the cached OUT_DIR copy instead of the editable icon sources. `build.rs` now
tracks the icons directory to invalidate that cache.

- Rebuilt with the normal frontend/sidecar hooks using `tauri build --debug
  --bundles app` (updater artifacts disabled only for this local QA build).
- The resulting `target/debug/bundle/macos/wechat-cc.app` ICNS matches the source:
  `3ca24e5312523928635cd548ed2b87a624fefbc7274b31cb5fd97c452e7dd1ce`.
- After relaunching Tauri dev, the executable contains the current source ICNS
  bytes; before the rebuild it did not.
- The running release companion and its installed bundle were not replaced.
  This confirms the rebuilt files and dev embedding, not a native screenshot
  assessment of macOS Dock appearance.
