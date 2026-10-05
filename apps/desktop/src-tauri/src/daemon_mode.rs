//! `wechat-cc --daemon …` — headless: no window, no Dock icon, no Tauri runtime.
//!
//! WHY (2026-09-04): macOS attributes privacy permissions (TCC) to the
//! *responsible process*. When launchd starts the daemon as
//! `~/.bun/bin/bun cli.ts run`, the identity is **bun** — every bun script on
//! the machine shares the grant, System Settings lists "bun", and there is no
//! usage description. Worse, the packaged sidecar is ad-hoc signed, so its
//! identity changes with every build and grants silently evaporate.
//!
//! The fix is structural: the LaunchAgent launches *this* executable (the
//! app's main binary, inside the signed bundle with its Info.plist usage
//! strings), and this executable spawns the sidecar. Then:
//!   - the prompt says "wechat-cc 想要访问…" with our own wording
//!   - System Settings shows the wechat-cc icon
//!   - claude / codex / agy / wxvault are all descendants → inherit the grant
//!   - swapping the LLM provider never touches permissions
//!
//! Deliberately std-only. No Tauri here: building the Tauri app would create
//! an NSApplication, and even without a window that means activation-policy
//! juggling to stay out of the Dock. A plain process that execs the sidecar
//! has none of that.
//!
//! Lifecycle: launchd's default `AbandonProcessGroup=false` SIGKILLs the whole
//! process group when the job is unloaded, so the sidecar dies with us. We do
//! not forward signals ourselves — one fewer place to be wrong.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{self, Command};

/// Sidecar lives next to the main binary inside `Contents/MacOS/`. macOS ships it
/// as `tendhearth-cc-cli` since 1.7.5 (bundle_migrate::SIDECAR_NAMES); older
/// bundles (and a rollback to one) still have `wechat-cc-cli`.
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent dir".to_string())?;
    crate::bundle_migrate::find_sidecar(dir)
        .ok_or_else(|| format!("sidecar not found in {}", dir.display()))
}

/// Manifest every plugin dir carries (src/lib/plugins-source.ts MANIFEST_FILE).
const PLUGIN_MANIFEST: &str = "wechat-cc.plugin.json";

/// Where Tauri puts `resources: ["../../../plugins/…"]` under the resource dir
/// (each `..` becomes `_up_`), plus the plain `plugins` spot. Shared with lib.rs.
pub(crate) const PLUGIN_RESOURCE_SUBDIRS: [&str; 2] = ["_up_/_up_/_up_/plugins", "plugins"];

/// True when `dir` holds at least one `<name>/wechat-cc.plugin.json`. A dir
/// with only the README (what the published installer ships, by design since
/// 1747de09) is NOT a plugins dir — passing it as WECHAT_CC_BUNDLED_PLUGINS_DIR
/// used to hide every other place the daemon could look (2026-09-30).
pub(crate) fn dir_has_plugins(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let p = e.path(); // is_dir/is_file follow symlinks — the owner wires plugins as symlinks
        p.is_dir() && p.join(PLUGIN_MANIFEST).is_file()
    })
}

/// First resource subdir under `resources` that really holds plugins.
pub(crate) fn find_plugins_in_resources(resources: &Path) -> Option<PathBuf> {
    PLUGIN_RESOURCE_SUBDIRS
        .iter()
        .map(|rel| resources.join(rel))
        .find(|p| dir_has_plugins(p))
}

/// Bundled plugins dir inside this .app, if it actually ships any.
/// Mirrors `bundled_plugins_dir` in lib.rs without needing an AppHandle.
fn bundled_plugins_dir() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    // …/Tendhearth CC.app/Contents/MacOS/Tendhearth CC → …/Contents/Resources
    let contents = exe.parent()?.parent()?;
    find_plugins_in_resources(&contents.join("Resources"))
}

/// Run the sidecar with the remaining args (typically `run --dangerously`)
/// and exit with its status. Never returns.
pub fn run(args: Vec<String>) -> ! {
    let sidecar = match sidecar_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("wechat-cc --daemon: {e}");
            process::exit(2);
        }
    };
    let mut cmd = Command::new(&sidecar);
    cmd.args(&args);
    // An explicit value from the LaunchAgent plist wins; otherwise only pass a
    // dir that really holds plugins. With neither, the sidecar resolves on its
    // own (owner pointer in the state dir → its own .app → nothing, loudly).
    if env::var_os("WECHAT_CC_BUNDLED_PLUGINS_DIR").is_none() {
        if let Some(dir) = bundled_plugins_dir() {
            cmd.env("WECHAT_CC_BUNDLED_PLUGINS_DIR", dir);
        }
    }
    // Tell the sidecar who launched it — the CLI's service planner uses this
    // to keep pointing the LaunchAgent at the app binary rather than at itself.
    cmd.env("WECHAT_CC_LAUNCHED_BY_APP", "1");
    let status = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("wechat-cc --daemon: spawn {}: {e}", sidecar.display());
            process::exit(2);
        }
    };
    process::exit(status.code().unwrap_or(1));
}

/// `--daemon` must be the FIRST argument. Returns the remaining args when set.
pub fn parse(argv: &[String]) -> Option<Vec<String>> {
    if argv.len() >= 2 && argv[1] == "--daemon" {
        Some(argv[2..].to_vec())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{dir_has_plugins, find_plugins_in_resources, parse};
    use std::fs;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wcc-daemon-mode-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn plugins_root(dir: &PathBuf, names: &[&str]) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("README.md"), "x").unwrap();
        for n in names {
            fs::create_dir_all(dir.join(n)).unwrap();
            fs::write(dir.join(n).join("wechat-cc.plugin.json"), "{}").unwrap();
        }
    }

    #[test]
    fn readme_only_dir_is_not_a_plugins_dir() {
        let d = tmp("readme");
        plugins_root(&d, &[]);
        assert!(!dir_has_plugins(&d));
        plugins_root(&d, &["wxvault"]);
        assert!(dir_has_plugins(&d));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn finds_tauri_up_layout_and_skips_readme_shells() {
        let res = tmp("res");
        // the shipped 1.7.x layout: README-only `_up_` dir ⇒ nothing
        plugins_root(&res.join("_up_/_up_/_up_/plugins"), &[]);
        assert_eq!(find_plugins_in_resources(&res), None);
        // a plain `plugins` dir with a plugin is still found behind the empty `_up_` one
        plugins_root(&res.join("plugins"), &["wxvault"]);
        assert_eq!(find_plugins_in_resources(&res), Some(res.join("plugins")));
        // and the `_up_` layout wins when it has plugins
        plugins_root(&res.join("_up_/_up_/_up_/plugins"), &["wxvault"]);
        assert_eq!(find_plugins_in_resources(&res), Some(res.join("_up_/_up_/_up_/plugins")));
        let _ = fs::remove_dir_all(&res);
    }

    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn daemon_flag_must_be_first() {
        assert_eq!(parse(&v(&["wechat-cc", "--daemon", "run", "--dangerously"])), Some(v(&["run", "--dangerously"])));
        assert_eq!(parse(&v(&["wechat-cc", "run", "--daemon"])), None);
        assert_eq!(parse(&v(&["wechat-cc"])), None);
    }

    #[test]
    fn no_args_after_flag_is_fine() {
        assert_eq!(parse(&v(&["wechat-cc", "--daemon"])), Some(vec![]));
    }
}
