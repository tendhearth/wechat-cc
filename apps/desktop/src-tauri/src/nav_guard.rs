// 导航守卫(2026-10-13,#295 欠的 Rust 那一半)。
//
// 记忆页曾放行原始 HTML(#295 已改安全渲染):提示注入写进记忆的 `<meta refresh>` 能把主窗口整个导到外站。
// Tauri v2 只给 app 自己的源 IPC,外站拿不到 app 命令;剩下的风险是一整页长得像 CC 的钓鱼页。
// 这里把每个 webview 的导航(macOS 上 wry 对子框架也调同一个钩子)限在 app 自己的源 + 预览框会用到的几种:
//   - app 自己:tauri:// / http(s)://tauri.localhost(Windows)、asset、ipc;
//   - 预览:cc-preview://(macOS)/ http://cc-preview.localhost(Windows)、blob:、本机 127.0.0.1 / localhost 的开发服务器(CSP frame-src 同一张单子);
//   - about:blank / about:srcdoc。
// 别的一律拒(外站 http(s)、data:、file:、javascript: …)。外链本来就由前端拦下交给系统浏览器(#230),不走这里。
use tauri::Url;

pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "ipc" | "blob" | "cc-preview" => true,
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "asset.localhost" | "ipc.localhost" | "cc-preview.localhost" | "127.0.0.1" | "localhost")
        ),
        _ => false,
    }
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|webview, url| {
            let allowed = navigation_allowed(url);
            if !allowed {
                // 只记 scheme + host:路径 / 查询里可能有令牌
                eprintln!("[nav-guard] blocked {} navigation to {}://{}", webview.label(), url.scheme(), url.host_str().unwrap_or(""));
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;
    use tauri::Url;

    fn ok(u: &str) -> bool { navigation_allowed(&Url::parse(u).unwrap()) }

    #[test]
    fn allows_the_app_and_preview_origins() {
        for u in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/memory.html",
            "asset://localhost/x.png",
            "cc-preview://localhost/abc/index.html",
            "http://cc-preview.localhost/abc/index.html",
            "blob:tauri://localhost/123e4567-e89b-12d3-a456-426614174000",
            "http://127.0.0.1:4174/",
            "http://localhost:5173/",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(ok(u), "{u}");
        }
    }

    #[test]
    fn blocks_outside_sites_and_dangerous_schemes() {
        for u in [
            "https://evil.example/login",
            "http://tauri.localhost.evil.example/",
            "https://localhost.evil.example/",
            "data:text/html,<h1>x</h1>",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "about:config",
            "ftp://127.0.0.1/",
        ] {
            assert!(!ok(u), "{u}");
        }
    }
}
