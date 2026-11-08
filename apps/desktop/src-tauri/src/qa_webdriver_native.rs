// QA-only observations of our own views. No event is posted and no pointer moves.
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView, NSWindow};
use objc2_foundation::{MainThreadMarker, NSPoint};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { label: String, nonce: String }

fn receipt(app: &AppHandle, request: &Request, result: Result<Value, String>) {
    let payload = match result {
        Ok(native) => json!({ "label": request.label, "nonce": request.nonce, "ok": true, "native": native }),
        Err(error) => json!({ "label": request.label, "nonce": request.nonce, "ok": false, "error": error }),
    };
    let _ = app.emit("cc-motion-qa-native-read-result", payload);
}

fn snapshot(platform: tauri::webview::PlatformWebview) -> Result<Value, String> {
    let _thread = MainThreadMarker::new().ok_or("native observation requires main thread")?;
    // Tauri documents these live WKWebView/NSWindow pointers. WKWebView inherits
    // NSView; borrow only inside the main-thread with_webview callback.
    let view = unsafe { platform.inner().cast::<NSView>().as_ref() }.ok_or("native view is null")?;
    let window = unsafe { platform.ns_window().cast::<NSWindow>().as_ref() }.ok_or("native window is null")?;
    let frame = window.frame();
    let probe = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(),
        0.0, window.windowNumber(), None, 0, 1, 1.0,
    ).ok_or("cannot construct first-mouse policy probe")?;
    Ok(json!({
        "coordinateSpace": "appkit-global-points-bottom-left",
        "frame": { "x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height },
        "windowNumber": window.windowNumber(), "backingScale": window.backingScaleFactor(),
        "visible": window.isVisible(), "key": window.isKeyWindow(), "movable": window.isMovable(),
        "acceptsFirstMouse": view.acceptsFirstMouse(Some(&probe)),
    }))
}

pub(crate) fn install(app: &AppHandle) {
    let reader = app.clone();
    app.listen("cc-motion-qa-native-read", move |event| {
        let Ok(request) = serde_json::from_str::<Request>(event.payload()) else { return; };
        if !matches!(request.label.as_str(), "main" | "companion") || request.nonce.is_empty() || request.nonce.len() > 128 { return; }
        let Some(window) = reader.get_webview_window(&request.label) else {
            receipt(&reader, &request, Err("requested QA window is not open".into())); return;
        };
        let callback_app = reader.clone();
        let callback_request = request.clone();
        if let Err(error) = window.with_webview(move |platform| receipt(&callback_app, &callback_request, snapshot(platform))) {
            receipt(&reader, &request, Err(error.to_string()));
        }
    });
}
