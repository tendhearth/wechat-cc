//! Ephemeral saved HTML/site previews. No disk access and no application API.
//! IDs only identify entries; they are not bearer credentials. The protocol and
//! command adapters restrict this store to the main app webview.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SITE_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_SITE_FILES: usize = 100;
pub const MAX_PREVIEWS: usize = 4;
pub const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
pub const PREVIEW_HEADERS: [(&str, &str); 5] = [
    ("content-type", "text/html; charset=utf-8"),
    ("content-security-policy", PREVIEW_CSP),
    ("x-content-type-options", "nosniff"),
    ("cache-control", "no-store"),
    ("referrer-policy", "no-referrer"),
];
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Tauri command input. MIME is matched exactly to the declared file extension.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiteFile { pub path: String, pub mime: String, pub content_base64: String }

#[derive(Clone)]
struct Resource { content_type: &'static str, bytes: Arc<[u8]> }
struct Entry { id: String, entry_path: String, site: bool, resources: HashMap<String, Resource> }
#[derive(Default)]
pub struct HtmlPreviewStore(Mutex<VecDeque<Entry>>);

pub struct PreviewResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub csp: String,
    pub cors: bool,
}
impl PreviewResponse {
    pub fn error(status: u16, message: &str) -> Self {
        Self { status, body: message.as_bytes().to_vec(), content_type: "text/html; charset=utf-8", csp: PREVIEW_CSP.into(), cors: false }
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn preview_origin(windows: bool) -> &'static str {
    // Tauri maps custom protocols to http://<scheme>.localhost on Windows.
    if windows { "http://cc-preview.localhost" } else { "cc-preview://localhost" }
}

pub fn preview_url(id: &str, windows: bool) -> String {
    format!("{}/{id}/index.html", preview_origin(windows))
}

pub fn site_preview_url(id: &str, entry: &str, windows: bool) -> String {
    format!("{}/{id}/{}", preview_origin(windows), encode_url_path(entry))
}

fn site_csp(id: &str, windows: bool) -> String {
    // The trailing slash is significant: CSP path matching includes only this
    // preview's resources, not another preview or the application's own paths.
    let prefix = format!("{}/{id}/", preview_origin(windows));
    format!("default-src 'none'; script-src 'unsafe-inline' {prefix}; style-src 'unsafe-inline' {prefix}; img-src data: blob: {prefix}; font-src data: {prefix}; connect-src {prefix}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
}

fn valid_site_path(path: &str) -> bool {
    if path.is_empty() || path.chars().count() > 512 || path.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '%' | '?' | '#')) { return false; }
    path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn site_content_type(path: &str, mime: &str) -> Option<&'static str> {
    let (_, extension) = path.rsplit_once('.')?;
    let (expected, content_type) = match extension.to_ascii_lowercase().as_str() {
        "html" | "htm" => ("text/html", "text/html; charset=utf-8"),
        "css" => ("text/css", "text/css; charset=utf-8"),
        "js" | "mjs" => ("text/javascript", "text/javascript; charset=utf-8"),
        "json" => ("application/json", "application/json; charset=utf-8"),
        "txt" => ("text/plain", "text/plain; charset=utf-8"),
        "png" => ("image/png", "image/png"),
        "jpg" | "jpeg" => ("image/jpeg", "image/jpeg"),
        "webp" => ("image/webp", "image/webp"),
        "gif" => ("image/gif", "image/gif"),
        "svg" => ("image/svg+xml", "image/svg+xml"),
        "ico" => ("image/x-icon", "image/x-icon"),
        "woff" => ("font/woff", "font/woff"),
        "woff2" => ("font/woff2", "font/woff2"),
        "ttf" => ("font/ttf", "font/ttf"),
        _ => return None,
    };
    (mime == expected).then_some(content_type)
}

fn encode_url_path(path: &str) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') { out.push(b as char); }
        else { out.push('%'); out.push(HEX[(b >> 4) as usize] as char); out.push(HEX[(b & 15) as usize] as char); }
    }
    out
}

fn decode_url_path(path: &str) -> Option<String> {
    fn hex(b: u8) -> Option<u8> { match b { b'0'..=b'9' => Some(b-b'0'), b'a'..=b'f' => Some(b-b'a'+10), b'A'..=b'F' => Some(b-b'A'+10), _ => None } }
    let input = path.as_bytes();
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let decoded = (hex(*input.get(i+1)?)? << 4) | hex(*input.get(i+2)?)?;
            // Encoded separators must not acquire path structure after decoding.
            if matches!(decoded, b'/' | b'\\') { return None; }
            out.push(decoded); i += 3;
        } else { out.push(input[i]); i += 1; }
    }
    let decoded = String::from_utf8(out).ok()?;
    valid_site_path(&decoded).then_some(decoded)
}

impl HtmlPreviewStore {
    pub fn prepare(&self, html: String) -> Result<String, String> {
        if html.len() > MAX_HTML_BYTES { return Err("html_preview_too_large".into()); }
        let mut resources = HashMap::new();
        resources.insert("index.html".into(), Resource { content_type: "text/html; charset=utf-8", bytes: html.into_bytes().into() });
        self.insert("index.html".into(), false, resources)
    }

    pub fn prepare_site(&self, entry: String, files: Vec<SiteFile>) -> Result<String, String> {
        if !valid_site_path(&entry) { return Err("invalid_site_preview_path".into()); }
        if files.is_empty() || files.len() > MAX_SITE_FILES { return Err("site_preview_file_count".into()); }
        let mut resources = HashMap::new();
        let mut total = 0usize;
        for file in files {
            if !valid_site_path(&file.path) { return Err("invalid_site_preview_path".into()); }
            if resources.contains_key(&file.path) { return Err("duplicate_site_preview_path".into()); }
            let content_type = site_content_type(&file.path, &file.mime).ok_or("invalid_site_preview_mime")?;
            let remaining = MAX_SITE_BYTES - total;
            // Bound decoded allocation before calling the strict STANDARD decoder.
            // It rejects whitespace, omitted/excess padding and nonzero pad bits.
            let encoded_limit = ((remaining + 2) / 3) * 4;
            if file.content_base64.len() > encoded_limit { return Err("site_preview_too_large".into()); }
            let bytes = STANDARD.decode(&file.content_base64).map_err(|_| "invalid_site_preview_base64".to_string())?;
            if bytes.len() > remaining { return Err("site_preview_too_large".into()); }
            total += bytes.len();
            resources.insert(file.path, Resource { content_type, bytes: bytes.into() });
        }
        let Some(resource) = resources.get(&entry) else { return Err("site_preview_entry_missing".into()); };
        if resource.content_type != "text/html; charset=utf-8" { return Err("site_preview_entry_not_html".into()); }
        self.insert(entry, true, resources)
    }

    fn insert(&self, entry_path: String, site: bool, resources: HashMap<String, Resource>) -> Result<String, String> {
        let serial = NEXT_ID.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| "html_preview_id_exhausted".to_string())?;
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
        let id = format!("{epoch:016x}{serial:016x}");
        let mut entries = self.0.lock().map_err(|_| "html_preview_unavailable".to_string())?;
        // FIFO caps all resources across HTML/site bundles at at most 32 MiB.
        // Invalid bundles never enter the store or evict a valid older preview.
        while entries.len() >= MAX_PREVIEWS { entries.pop_front(); }
        entries.push_back(Entry { id: id.clone(), entry_path, site, resources });
        Ok(id)
    }

    pub fn url_for(&self, id: &str, windows: bool) -> Result<String, String> {
        let entries = self.0.lock().map_err(|_| "html_preview_unavailable".to_string())?;
        let entry = entries.iter().find(|entry| entry.id == id).ok_or("html_preview_not_found")?;
        Ok(site_preview_url(id, &entry.entry_path, windows))
    }

    pub fn release(&self, id: &str) -> Result<bool, String> {
        if !valid_id(id) { return Err("invalid_html_preview_id".into()); }
        let mut entries = self.0.lock().map_err(|_| "html_preview_unavailable".to_string())?;
        if let Some(index) = entries.iter().position(|entry| entry.id == id) { entries.remove(index); Ok(true) }
        else { Ok(false) }
    }

    pub fn respond(&self, method: &str, path: &str, has_query: bool, windows: bool) -> PreviewResponse {
        if method != "GET" { return PreviewResponse::error(405, "Method not allowed"); }
        let Some((id, raw_path)) = path.strip_prefix('/').and_then(|value| value.split_once('/')) else { return PreviewResponse::error(404, "Preview not found"); };
        if !valid_id(id) { return PreviewResponse::error(404, "Preview not found"); }
        let (site, resource) = {
            let Ok(entries) = self.0.lock() else { return PreviewResponse::error(503, "Preview unavailable"); };
            let Some(entry) = entries.iter().find(|entry| entry.id == id) else { return PreviewResponse::error(404, "Preview not found"); };
            if !entry.site && has_query { return PreviewResponse::error(400, "Invalid preview path"); }
            let resource_path = if entry.site {
                let Some(decoded) = decode_url_path(raw_path) else { return PreviewResponse::error(404, "Preview not found"); };
                decoded
            } else {
                // Preserve standalone HTML's original exact-path contract.
                if raw_path != "index.html" { return PreviewResponse::error(404, "Preview not found"); }
                raw_path.into()
            };
            (entry.site, entry.resources.get(&resource_path).cloned())
        };
        let mut response = match resource {
            Some(resource) => PreviewResponse { status: 200, body: resource.bytes.as_ref().to_vec(), content_type: resource.content_type, csp: PREVIEW_CSP.into(), cors: false },
            None => PreviewResponse::error(404, "Preview not found"),
        };
        if site { response.csp = site_csp(id, windows); response.cors = true; }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path(id: &str) -> String { format!("/{id}/index.html") }

    #[test]
    fn serves_exact_utf8_document_and_releases_idempotently() {
        let store = HtmlPreviewStore::default();
        let html = "<!doctype html><button onclick=\"this.textContent='已完成'\">开始</button><script>let x=1</script>";
        let id = store.prepare(html.into()).unwrap();
        assert!(valid_id(&id));
        let response = store.respond("GET", &path(&id), false, false);
        assert_eq!(response.status, 200);
        assert_eq!(response.body, html.as_bytes());
        assert!(store.release(&id).unwrap());
        assert!(!store.release(&id).unwrap());
        assert_eq!(store.respond("GET", &path(&id), false, false).status, 404);
    }

    #[test]
    fn enforces_byte_limit_at_the_boundary_and_for_multibyte_text() {
        let store = HtmlPreviewStore::default();
        let id = store.prepare("x".repeat(MAX_HTML_BYTES)).unwrap();
        assert_eq!(store.respond("GET", &path(&id), false, false).body.len(), MAX_HTML_BYTES);
        assert_eq!(store.prepare("x".repeat(MAX_HTML_BYTES + 1)).unwrap_err(), "html_preview_too_large");
        assert_eq!(store.prepare("你".repeat(MAX_HTML_BYTES / 3 + 1)).unwrap_err(), "html_preview_too_large");
    }

    #[test]
    fn fifth_preview_evicts_only_the_oldest_and_ids_are_unique_across_stores() {
        let store = HtmlPreviewStore::default();
        let ids: Vec<_> = (0..5).map(|n| store.prepare(format!("document {n}")).unwrap()).collect();
        assert_eq!(store.0.lock().unwrap().len(), MAX_PREVIEWS);
        assert_eq!(store.respond("GET", &path(&ids[0]), false, false).status, 404);
        for id in &ids[1..] { assert_eq!(store.respond("GET", &path(id), false, false).status, 200); }
        let other = HtmlPreviewStore::default().prepare("other".into()).unwrap();
        assert!(!ids.contains(&other));
    }

    #[test]
    fn rejects_methods_queries_encoded_paths_and_traversal() {
        let store = HtmlPreviewStore::default();
        let id = store.prepare("document".into()).unwrap();
        assert_eq!(store.respond("POST", &path(&id), false, false).status, 405);
        assert_eq!(store.respond("GET", &path(&id), true, false).status, 400);
        for invalid in ["/../index.html", "/%2e%2e/index.html", "/index.html", "/a/index.html", "/0000000000000000000000000000000g/index.html"] {
            assert_eq!(store.respond("GET", invalid, false, false).status, 404);
        }
        assert!(store.release("../").is_err());
    }

    #[test]
    fn policy_is_separate_and_has_only_the_requested_inline_capabilities() {
        assert!(PREVIEW_CSP.contains("script-src 'unsafe-inline'"));
        assert!(PREVIEW_CSP.contains("style-src 'unsafe-inline'"));
        for directive in ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "sandbox allow-scripts"] {
            assert!(PREVIEW_CSP.split(';').any(|part| part.trim() == directive));
        }
        assert!(!PREVIEW_CSP.contains("allow-same-origin"));
        assert!(!PREVIEW_CSP.contains("unsafe-eval"));
        assert!(!PREVIEW_CSP.contains("'self'"));
    }

    #[test]
    fn windows_uses_the_tauri_http_scheme_origin() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(preview_url(id, true), format!("http://cc-preview.localhost/{id}/index.html"));
        assert_eq!(preview_url(id, false), format!("cc-preview://localhost/{id}/index.html"));
    }
}

#[cfg(test)]
mod site_tests {
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
fn file(path:&str,mime:&str,bytes:&[u8])->SiteFile { SiteFile{path:path.into(),mime:mime.into(),content_base64:STANDARD.encode(bytes)} }
fn html(path:&str)->SiteFile { file(path,"text/html",b"<!doctype html><link rel=stylesheet href=assets/site.css><script type=module src=assets/site.mjs></script>") }
fn path(id:&str,resource:&str)->String {format!("/{id}/{resource}")}
#[test]
fn declared_site_linked_css_and_js_are_served_from_the_same_frozen_entry() {
    let store=HtmlPreviewStore::default();
    let id=store.prepare_site("index.html".into(),vec![html("index.html"),file("assets/site.css","text/css",b"body{color:red}"),file("assets/site.mjs","text/javascript",b"document.body.dataset.ready='yes'")]).unwrap();
    let css=store.respond("GET",&path(&id,"assets/site.css"),false,false);
    assert_eq!(css.status,200);
    assert_eq!(css.body,b"body{color:red}");
    assert_eq!(css.content_type,"text/css; charset=utf-8");
    let js=store.respond("GET",&path(&id,"assets/site.mjs"),false,false);
    assert_eq!(js.status,200);
    assert_eq!(js.content_type,"text/javascript; charset=utf-8");
    assert_eq!(store.respond("GET",&path(&id,"index.html"),false,false).status,200);
}

#[test]
fn unicode_spaces_nested_pages_and_query_cachebusters_resolve_once() {
    let store=HtmlPreviewStore::default();
    let id=store.prepare_site("页面/首页 空格.html".into(),vec![html("页面/首页 空格.html"),file("页面/资源 图.png","image/png",b"png"),html("页面/about.html")]).unwrap();
    assert_eq!(site_preview_url(&id,"页面/首页 空格.html",false),format!("cc-preview://localhost/{id}/%E9%A1%B5%E9%9D%A2/%E9%A6%96%E9%A1%B5%20%E7%A9%BA%E6%A0%BC.html"));
    assert_eq!(store.url_for(&id, false).unwrap(), format!("cc-preview://localhost/{id}/%E9%A1%B5%E9%9D%A2/%E9%A6%96%E9%A1%B5%20%E7%A9%BA%E6%A0%BC.html"));
    assert_eq!(store.respond("GET",&path(&id,"%E9%A1%B5%E9%9D%A2/%E8%B5%84%E6%BA%90%20%E5%9B%BE.png"),true,false).body,b"png");
    assert_eq!(store.respond("GET",&path(&id,"页面/about.html"),false,false).status,200);
    assert_eq!(store.respond("GET",&path(&id,"页面/missing.html"),false,false).status,404);
}

#[test]
fn declaration_paths_reject_traversal_absolute_and_url_ambiguity() {
    let store=HtmlPreviewStore::default();
    for invalid in ["../bad.css","./bad.css","a/../bad.css","a/./bad.css","/bad.css","\\bad.css","C:/bad.css","C:bad.css","//bad.css","a//bad.css","a/bad.css?x","a/bad.css#x","a/%62ad.css","a/\0bad.css","a/\u{7f}bad.css","a/\nbad.css", "a/\u{85}bad.css"] {
        assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file(invalid,"text/css",b"a")]).is_err(),"accepted declaration {invalid:?}");
    }
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file("assets/.hidden-file.css","text/css",b"a")]).is_ok());
}

#[test]
fn resource_paths_reject_traversal_encoded_slashes_double_encoding_and_invalid_utf8() {
    let store=HtmlPreviewStore::default();
    let id=store.prepare_site("index.html".into(),vec![html("index.html"),file("assets/site.css","text/css",b"a")]).unwrap();
    for invalid in ["../index.html","./index.html","%2e%2e/index.html","%2E/index.html","assets%2Fsite.css","assets%2fsite.css","assets%5Csite.css","assets%5csite.css","%252e%252e/index.html","assets/%FF.css","assets/%F0%80%80%AF.css","assets/%GG.css","assets/%.css","assets/%00.css","assets/site.css%3fx","assets/site.css%23x","/index.html","assets//site.css"] {
        assert_eq!(store.respond("GET",&path(&id,invalid),false,false).status,404,"served {invalid:?}");
    }
    assert_eq!(store.respond("POST",&path(&id,"index.html"),false,false).status,405);
}

#[test]
fn exact_mime_is_tied_to_the_extension_and_entry_must_be_declared_html() {
    let store=HtmlPreviewStore::default();
    assert!(store.prepare_site("missing.html".into(),vec![html("index.html")]).is_err());
    assert!(store.prepare_site("site.css".into(),vec![file("site.css","text/css",b"a")]).is_err());
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file("source.js","text/html",b"alert(1)")]).is_err());
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file("source.js","application/javascript",b"alert(1)")]).is_err());
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file("source.exe","text/plain",b"bytes")]).is_err());
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),file("site.css","text/css\r\nx-test: injected",b"a")]).is_err());
    let cases=[("PAGE.HTM","text/html","text/html; charset=utf-8"),("a.css","text/css","text/css; charset=utf-8"),("a.js","text/javascript","text/javascript; charset=utf-8"),("a.mjs","text/javascript","text/javascript; charset=utf-8"),("a.json","application/json","application/json; charset=utf-8"),("a.txt","text/plain","text/plain; charset=utf-8"),("a.png","image/png","image/png"),("a.jpg","image/jpeg","image/jpeg"),("a.jpeg","image/jpeg","image/jpeg"),("a.webp","image/webp","image/webp"),("a.gif","image/gif","image/gif"),("a.svg","image/svg+xml","image/svg+xml"),("a.ico","image/x-icon","image/x-icon"),("a.woff","font/woff","font/woff"),("a.woff2","font/woff2","font/woff2"),("a.ttf","font/ttf","font/ttf")];
    for (resource,mime,content_type) in cases {
        let id=store.prepare_site("index.html".into(),vec![html("index.html"),file(resource,mime,b"bytes")]).unwrap();
        assert_eq!(store.respond("GET",&path(&id,resource),false,false).content_type,content_type);
    }
}

#[test]
fn duplicate_resources_or_entries_are_rejected_as_a_whole_without_evicting_a_good_preview() {
    let store=HtmlPreviewStore::default();
    let ids:Vec<_>=(0..4).map(|_|store.prepare_site("index.html".into(),vec![html("index.html")]).unwrap()).collect();
    assert!(store.prepare_site("index.html".into(),vec![html("index.html"),html("index.html")]).is_err());
    for id in ids {assert_eq!(store.respond("GET",&path(&id,"index.html"),false,false).status,200);}
}

#[test]
fn canonical_bounded_base64_rejects_whitespace_missing_padding_and_nonzero_trailing_bits() {
    let store=HtmlPreviewStore::default();
    for invalid in ["Zg", "Zh==", "Zg==\n", "Zg== ", "____", "====", "Zm9v=", "Zg===", "!!!!"] {
        let asset=SiteFile{path:"a.txt".into(),mime:"text/plain".into(),content_base64:invalid.into()};
        assert!(store.prepare_site("index.html".into(),vec![html("index.html"),asset]).is_err(),"accepted base64 {invalid:?}");
    }
    let id=store.prepare_site("index.html".into(),vec![html("index.html"),file("a.txt","text/plain",b"f")]).unwrap();
    assert_eq!(store.respond("GET",&path(&id,"a.txt"),false,false).body,b"f");
}

#[test]
fn site_file_count_and_decoded_total_byte_limits_are_enforced_at_the_boundary() {
    let store=HtmlPreviewStore::default();
    assert!(store.prepare_site("index.html".into(),vec![]).is_err());
    let files=||{let mut list=vec![file("index.html","text/html",b"")];list.extend((0..99).map(|n|file(&format!("a{n}.css"),"text/css",b"")));list};
    assert!(store.prepare_site("index.html".into(),files()).is_ok());
    let mut too_many=files();too_many.push(file("overflow.css","text/css",b""));
    assert!(store.prepare_site("index.html".into(),too_many).is_err());
    let bytes=vec![b'x';6*1024*1024];
    let id=store.prepare_site("index.html".into(),vec![file("index.html","text/html",&bytes)]).unwrap();
    assert_eq!(store.respond("GET",&path(&id,"index.html"),false,false).body.len(),6*1024*1024);
    assert!(store.prepare_site("index.html".into(),vec![file("index.html","text/html",&bytes),file("extra.txt","text/plain",b"x")]).is_err());
    assert!(store.prepare_site("index.html".into(),vec![file("index.html","text/html",&vec![b'x';6*1024*1024+1])]).is_err());
}

#[test]
fn site_csp_cors_are_scoped_to_one_preview_with_platform_appropriate_origins() {
    let store=HtmlPreviewStore::default();
    let first=store.prepare_site("index.html".into(),vec![html("index.html")]).unwrap();
    let second=store.prepare_site("index.html".into(),vec![html("index.html")]).unwrap();
    for (windows,origin) in [(false,"cc-preview://localhost"),(true,"http://cc-preview.localhost")] {
        let response=store.respond("GET",&path(&first,"index.html"),false,windows);
        let prefix=format!("{origin}/{first}/");
        assert!(response.cors);
        for directive in [format!("script-src 'unsafe-inline' {prefix}"),format!("style-src 'unsafe-inline' {prefix}"),format!("img-src data: blob: {prefix}"),format!("font-src data: {prefix}"),format!("connect-src {prefix}")] {assert!(response.csp.split(';').any(|p|p.trim()==directive));}
        for directive in ["default-src 'none'","frame-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'","sandbox allow-scripts"] {assert!(response.csp.split(';').any(|p|p.trim()==directive));}
        assert!(!response.csp.contains(&second));
        assert!(!response.csp.contains("allow-same-origin"));assert!(!response.csp.contains("unsafe-eval"));assert!(!response.csp.contains("'self'"));
    }
}

#[test]
fn one_bundle_is_released_and_evicted_atomically_including_all_resources() {
    let store=HtmlPreviewStore::default();
    let files=||vec![html("index.html"),file("a.css","text/css",b"a"),html("pages/about.html")];
    let ids:Vec<_>=(0..5).map(|_|store.prepare_site("index.html".into(),files()).unwrap()).collect();
    for resource in ["index.html","a.css","pages/about.html"] {assert_eq!(store.respond("GET",&path(&ids[0],resource),false,false).status,404);}
    assert!(store.release(&ids[1]).unwrap());assert!(!store.release(&ids[1]).unwrap());
    for resource in ["index.html","a.css","pages/about.html"] {assert_eq!(store.respond("GET",&path(&ids[1],resource),false,false).status,404);}
    for id in &ids[2..] {assert_eq!(store.respond("GET",&path(id,"a.css"),false,false).body,b"a");}
}

#[test]
fn standalone_html_keeps_its_original_policy_url_and_query_rejection() {
    let store=HtmlPreviewStore::default();
    let id=store.prepare("<script>window.test=1</script>".into()).unwrap();
    let response=store.respond("GET",&path(&id,"index.html"),false,false);
    assert_eq!(response.csp,PREVIEW_CSP);assert!(!response.cors);assert_eq!(response.content_type,"text/html; charset=utf-8");
    assert_eq!(preview_url(&id,false),format!("cc-preview://localhost/{id}/index.html"));
    assert_eq!(store.respond("GET",&path(&id,"index.html"),true,false).status,400);
    assert_eq!(store.respond("GET",&path(&id,"%69ndex.html"),false,false).status,404);
}

#[test]
fn command_file_payload_uses_camel_case_base64_and_rejects_unrecognized_fields() {
    let value:SiteFile=serde_json::from_str(r#"{"path":"index.html","mime":"text/html","contentBase64":"Zg=="}"#).unwrap();
    assert_eq!(value.content_base64,"Zg==");
    assert!(serde_json::from_str::<SiteFile>(r#"{"path":"index.html","mime":"text/html","content_base64":"Zg=="}"#).is_err());
    assert!(serde_json::from_str::<SiteFile>(r#"{"path":"index.html","mime":"text/html","contentBase64":"Zg==","extra":1}"#).is_err());
}

}
