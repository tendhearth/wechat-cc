#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `wechat-cc --daemon …`: headless supervisor for the sidecar, so launchd's
    // responsible process is this signed app binary (TCC identity), not bun
    // and not an ad-hoc-signed helper. See daemon_mode.rs.
    let argv: Vec<String> = std::env::args().collect();
    if let Some(rest) = wechat_cc_desktop_lib::daemon_mode::parse(&argv) {
        wechat_cc_desktop_lib::daemon_mode::run(rest);
    }
    // First launch after the 1.7.5 update: rename wechat-cc.app → Tendhearth CC.app,
    // repair the LaunchAgent, relaunch from the new path (bundle_migrate.rs).
    if wechat_cc_desktop_lib::bundle_migrate::on_startup() {
        std::process::exit(0);
    }
    wechat_cc_desktop_lib::run();
}
