//! Post-update self-rename: `wechat-cc.app` → `Tendhearth CC.app` (1.7.5).
//!
//! WHY (2026-10-04, docs/maintainer/app-rename-migration.md): tauri-plugin-updater
//! 2.10.1 on macOS installs an update INTO the running bundle's path — it strips the
//! tarball's top-level `<productName>.app/` component (`entry.path().iter().skip(1)`)
//! and renames the extracted contents onto `extract_path`, which is derived from
//! `current_exe()` (`…/X.app/Contents/MacOS/bin` → `…/X.app`). So an old install
//! updated to a build whose productName is "Tendhearth CC" keeps living at
//! `/Applications/wechat-cc.app` forever: Finder / Spotlight / Launchpad keep
//! showing "wechat-cc". The owner wants every user to end up with ONE app named
//! Tendhearth CC, so the app renames itself once, on the first launch after the
//! update, before any window exists:
//!
//!   1. rename `<dir>/wechat-cc.app` → `<dir>/Tendhearth CC.app` (same dir ⇒ atomic,
//!      same volume ⇒ inode/bookmarks follow: Dock pins and Finder aliases resolve);
//!   2. run the NEW bundle's sidecar `service repair --json`, which rewrites the
//!      LaunchAgent (ProgramArguments / WorkingDirectory), reloads it, fixes the
//!      terminal hooks and the `~/.local/bin/wechat-cc` forwarder;
//!   3. relaunch from the new path and exit (this process's `current_exe()` — and
//!      with it tauri-plugin-shell's sidecar resolution — is stale after the move).
//!
//! The rename never touches the bundle's CONTENTS, so the code signature, the
//! notarization ticket and TCC grants (keyed on bundle id + designated requirement,
//! not on the path) are unaffected.
//!
//! Every other launch: spawn `service repair --json` in the background — it is a
//! no-op unless the LaunchAgent points at a file that no longer exists (in-place
//! update changed the main-binary name, or the user moved the app).
//!
//! Release builds on macOS only. `WECHAT_CC_NO_BUNDLE_MIGRATE=1` turns all of it off.

use std::path::{Path, PathBuf};

/// Keep in sync with src/lib/app-identity.ts (guarded by app-identity.test.ts).
pub const APP_BUNDLE_NAME: &str = "Tendhearth CC.app";
pub const LEGACY_APP_BUNDLE_NAMES: [&str; 1] = ["wechat-cc.app"];
/// Sidecar names, newest first. macOS ships `tendhearth-cc-cli` since 1.7.5.
pub const SIDECAR_NAMES: [&str; 2] = ["tendhearth-cc-cli", "wechat-cc-cli"];

#[derive(Debug, PartialEq, Eq)]
pub enum RenamePlan {
    /// Already has the new name (or a name we never rename, e.g. the user's own choice).
    Stay,
    Rename { from: PathBuf, to: PathBuf },
    /// Legacy name but we must not move it; the reason is logged.
    Blocked(&'static str),
}

/// `…/X.app/Contents/MacOS/<bin>` → `…/X.app`.
pub fn bundle_of_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Pure decision. Only a legacy-named bundle sitting directly in `/Applications`
/// or `~/Applications` is renamed — never a dev build under `target/`, a
/// translocated copy, a mounted dmg, or a bundle the user renamed themselves.
pub fn plan_rename(bundle: &Path, home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> RenamePlan {
    let Some(name) = bundle.file_name().and_then(|n| n.to_str()) else { return RenamePlan::Stay };
    if !LEGACY_APP_BUNDLE_NAMES.contains(&name) {
        return RenamePlan::Stay;
    }
    let Some(parent) = bundle.parent() else { return RenamePlan::Blocked("no_parent") };
    let user_apps = home.map(|h| h.join("Applications"));
    let in_apps = parent == Path::new("/Applications") || user_apps.as_deref() == Some(parent);
    if !in_apps {
        return RenamePlan::Blocked("not_in_applications");
    }
    let to = parent.join(APP_BUNDLE_NAME);
    if exists(&to) {
        // A manual dmg install of the new version next to the old one, or a
        // half-finished earlier attempt. Never overwrite; the user sees two apps
        // and `service repair` keeps the LaunchAgent on whichever one runs.
        return RenamePlan::Blocked("target_exists");
    }
    RenamePlan::Rename { from: bundle.to_path_buf(), to }
}

/// The sidecar inside `<bundle>/Contents/MacOS`, newest name first.
pub fn find_sidecar(macos_dir: &Path) -> Option<PathBuf> {
    SIDECAR_NAMES.iter().map(|n| macos_dir.join(n)).find(|p| p.is_file())
}

#[cfg(target_os = "macos")]
#[allow(dead_code)] // only reached from release builds
fn run_repair_blocking(macos_dir: &Path) -> Result<String, String> {
    let sidecar = find_sidecar(macos_dir).ok_or_else(|| format!("no sidecar in {}", macos_dir.display()))?;
    let out = std::process::Command::new(&sidecar)
        .args(["service", "repair", "--json"])
        .output()
        .map_err(|e| format!("spawn {}: {e}", sidecar.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{} {}", stdout, String::from_utf8_lossy(&out.stderr)))
    }
}

/// Called first thing in `main()`. Returns true when this process must exit
/// because a relaunch from the renamed bundle has been scheduled.
pub fn on_startup() -> bool {
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    {
        if std::env::var_os("WECHAT_CC_NO_BUNDLE_MIGRATE").is_some() {
            return false;
        }
        let Ok(exe) = std::env::current_exe() else { return false };
        let Some(bundle) = bundle_of_exe(&exe) else { return false };
        let home = std::env::var_os("HOME").map(PathBuf::from);
        match plan_rename(&bundle, home.as_deref(), |p| p.symlink_metadata().is_ok()) {
            RenamePlan::Rename { from, to } => match std::fs::rename(&from, &to) {
                Ok(()) => {
                    eprintln!("[bundle-migrate] renamed {} -> {}", from.display(), to.display());
                    match run_repair_blocking(&to.join("Contents").join("MacOS")) {
                        Ok(out) => eprintln!("[bundle-migrate] service repair: {}", out.trim()),
                        Err(e) => eprintln!("[bundle-migrate] service repair failed: {e}"),
                    }
                    // Give this process a moment to exit before the new one starts;
                    // `open -n` because LaunchServices would otherwise just
                    // re-activate us (same bundle id).
                    let spawned = std::process::Command::new("/bin/sh")
                        .args(["-c", "sleep 1; exec /usr/bin/open -n \"$0\""])
                        .arg(&to)
                        .spawn();
                    return spawned.is_ok();
                }
                // EACCES (standard user, root-owned /Applications) etc.: stay at
                // the old path — still fully functional; repair below fixes the
                // LaunchAgent for the new main-binary name.
                Err(e) => eprintln!("[bundle-migrate] rename {} failed: {e}", from.display()),
            },
            RenamePlan::Blocked(why) => eprintln!("[bundle-migrate] not renaming {}: {why}", bundle.display()),
            RenamePlan::Stay => {}
        }
        let macos_dir = bundle.join("Contents").join("MacOS");
        std::thread::spawn(move || {
            if let Err(e) = run_repair_blocking(&macos_dir) {
                eprintln!("[bundle-migrate] background service repair failed: {e}");
            }
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn p(s: &str) -> PathBuf { PathBuf::from(s) }

    #[test]
    fn renames_only_legacy_names_in_applications() {
        let none = |_: &Path| false;
        assert_eq!(
            plan_rename(&p("/Applications/wechat-cc.app"), Some(&p("/Users/u")), none),
            RenamePlan::Rename { from: p("/Applications/wechat-cc.app"), to: p("/Applications/Tendhearth CC.app") }
        );
        assert_eq!(
            plan_rename(&p("/Users/u/Applications/wechat-cc.app"), Some(&p("/Users/u")), none),
            RenamePlan::Rename { from: p("/Users/u/Applications/wechat-cc.app"), to: p("/Users/u/Applications/Tendhearth CC.app") }
        );
        assert_eq!(plan_rename(&p("/Applications/Tendhearth CC.app"), None, none), RenamePlan::Stay);
        assert_eq!(plan_rename(&p("/Applications/My CC.app"), None, none), RenamePlan::Stay);
        assert_eq!(
            plan_rename(&p("/repo/apps/desktop/src-tauri/target/release/bundle/macos/wechat-cc.app"), None, none),
            RenamePlan::Blocked("not_in_applications")
        );
        assert_eq!(
            plan_rename(&p("/private/var/folders/x/T/AppTranslocation/A/d/wechat-cc.app"), None, none),
            RenamePlan::Blocked("not_in_applications")
        );
        assert_eq!(plan_rename(&p("/Volumes/wechat-cc/wechat-cc.app"), None, none), RenamePlan::Blocked("not_in_applications"));
    }

    #[test]
    fn never_overwrites_an_existing_target() {
        assert_eq!(
            plan_rename(&p("/Applications/wechat-cc.app"), None, |q: &Path| q == Path::new("/Applications/Tendhearth CC.app")),
            RenamePlan::Blocked("target_exists")
        );
    }

    #[test]
    fn bundle_of_exe_handles_spaces_and_rejects_non_bundles() {
        assert_eq!(bundle_of_exe(&p("/Applications/Tendhearth CC.app/Contents/MacOS/Tendhearth CC")), Some(p("/Applications/Tendhearth CC.app")));
        assert_eq!(bundle_of_exe(&p("/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop")), Some(p("/Applications/wechat-cc.app")));
        assert_eq!(bundle_of_exe(&p("/repo/target/release/wechat_cc_desktop")), None);
    }

    #[test]
    fn rename_keeps_contents_and_inode_and_finds_new_sidecar() {
        // Throwaway "Applications" dir: the real move is a same-dir rename(2).
        let root = std::env::temp_dir().join(format!("wcc-bundle-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let macos = root.join("wechat-cc.app/Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("Tendhearth CC"), "main").unwrap();
        fs::write(macos.join("tendhearth-cc-cli"), "cli").unwrap();
        #[cfg(unix)]
        let ino_before = { use std::os::unix::fs::MetadataExt; fs::metadata(root.join("wechat-cc.app")).unwrap().ino() };
        let to = root.join(APP_BUNDLE_NAME);
        assert!(!to.exists());
        fs::rename(root.join("wechat-cc.app"), &to).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(&to).unwrap().ino(), ino_before, "rename must keep the inode (bookmarks / Dock pins follow it)");
        }
        assert_eq!(find_sidecar(&to.join("Contents/MacOS")), Some(to.join("Contents/MacOS/tendhearth-cc-cli")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn find_sidecar_falls_back_to_legacy_name() {
        let root = std::env::temp_dir().join(format!("wcc-sidecar-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(find_sidecar(&root), None);
        fs::write(root.join("wechat-cc-cli"), "x").unwrap();
        assert_eq!(find_sidecar(&root), Some(root.join("wechat-cc-cli")));
        let _ = fs::remove_dir_all(&root);
    }
}
