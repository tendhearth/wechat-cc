//! Companion-only UI placement. Geometry and preference IO have no window or daemon dependency.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Screen {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Placement {
    pub version: u8,
    pub screen: Screen,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Layout {
    /// Scale of the destination monitor, including its scaled global origin.
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const MAX_BYTES: u64 = 16_384;
pub(crate) const FILE_NAME: &str = "companion-placement-v1.json";

impl Screen {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height, self.scale].iter().all(|v| v.is_finite())
            && self.x.abs() <= 10_000_000.0 && self.y.abs() <= 10_000_000.0
            && (1.0..=100_000.0).contains(&self.width)
            && (1.0..=100_000.0).contains(&self.height)
            && (0.25..=8.0).contains(&self.scale)
            && self.name.as_ref().is_none_or(|name| name.len() <= 1024)
    }
    fn logical_width(&self) -> f64 { self.width / self.scale }
    fn logical_height(&self) -> f64 { self.height / self.scale }
    fn same_area(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y && self.width == other.width && self.height == other.height
    }
}

fn valid_size(width: f64, height: f64) -> bool {
    (200.0..=600.0).contains(&width) && (250.0..=750.0).contains(&height)
}

impl Placement {
    fn valid(&self) -> bool {
        self.version == 1 && self.screen.valid() && valid_size(self.width, self.height)
            && self.left.is_finite() && self.top.is_finite()
            && (0.0..=(self.screen.logical_width() - self.width).max(0.0)).contains(&self.left)
            && (0.0..=(self.screen.logical_height() - self.height).max(0.0)).contains(&self.top)
    }
}

/// Physical global origin plus logical inner size. Tiny work areas retain the
/// established minimum size; anchoring at the top-right keeps controls reachable.
fn fit(screen: &Screen, left: f64, top: f64, width: f64, height: f64, macos: bool) -> Layout {
    // Tao forwards fractional point sizes directly to AppKit. Native QA showed
    // AppKit ceiling 268.8×336.00000000000006 to 269×337. Send whole points,
    // including during restore/reset, and fit AFTER normalization so a rounded
    // dimension cannot extend past the work area. Other platforms keep their
    // physical-pixel sizing behavior.
    let (width, height) = if macos {
        (width.round().min(screen.logical_width().floor()).clamp(200.0, 600.0),
         height.round().min(screen.logical_height().floor()).clamp(250.0, 750.0))
    } else {
        (width.min(screen.logical_width()).clamp(200.0, 600.0),
         height.min(screen.logical_height()).clamp(250.0, 750.0))
    };
    let left = left.clamp(0.0, (screen.logical_width() - width).max(0.0));
    let top = top.clamp(0.0, (screen.logical_height() - height).max(0.0));
    Layout { x: screen.x + (left + (screen.logical_width() - width).min(0.0)) * screen.scale, y: screen.y + top * screen.scale, width, height, scale: screen.scale }
}

pub(crate) fn capture(screen: &Screen, layout: &Layout, visible: bool, minimized: bool) -> Option<Placement> {
    if !visible || minimized || !screen.valid()
        || !layout.x.is_finite() || !layout.y.is_finite() { return None; }
    // Native sizes are integral physical pixels. Allow half a physical pixel
    // of rounding at the logical limits, then persist strictly bounded values.
    let tolerance = 0.5 / screen.scale;
    if !(200.0 - tolerance..=600.0 + tolerance).contains(&layout.width)
        || !(250.0 - tolerance..=750.0 + tolerance).contains(&layout.height) { return None; }
    let width = layout.width.clamp(200.0, 600.0);
    let height = layout.height.clamp(250.0, 750.0);
    // Offscreen/minimized sentinel origins must not replace a usable placement.
    if layout.x >= screen.x + screen.width || layout.y >= screen.y + screen.height
        || layout.x + width * screen.scale <= screen.x
        || layout.y + height * screen.scale <= screen.y { return None; }
    let left = ((layout.x - screen.x) / screen.scale).clamp(0.0, (screen.logical_width() - width).max(0.0));
    let top = ((layout.y - screen.y) / screen.scale).clamp(0.0, (screen.logical_height() - height).max(0.0));
    Some(Placement { version: 1, screen: screen.clone(), left, top, width, height })
}

pub(crate) fn edge(screens: &[Screen], preferred: usize, width: f64, height: f64, macos: bool) -> Option<Layout> {
    let screen = screens.get(preferred).filter(|screen| screen.valid())
        .or_else(|| screens.iter().find(|screen| screen.valid()))?;
    let (width, height) = if valid_size(width, height) { (width, height) } else { (240.0, 300.0) };
    Some(fit(screen, screen.logical_width() - width - 16.0, screen.logical_height() - height - 16.0, width, height, macos))
}

pub(crate) fn restore(saved: Option<&Placement>, screens: &[Screen], preferred: usize, macos: bool) -> Option<Layout> {
    let fallback = screens.get(preferred).filter(|screen| screen.valid())
        .or_else(|| screens.iter().find(|screen| screen.valid()))?;
    if let Some(saved) = saved.filter(|saved| saved.valid()) {
        let screen = screens.iter().filter(|screen| screen.valid()).find(|screen| screen.same_area(&saved.screen))
            .or_else(|| screens.iter().filter(|screen| screen.valid()).find(|screen| screen.name.is_some() && screen.name == saved.screen.name))
            .unwrap_or(fallback);
        return Some(fit(screen, saved.left, saved.top, saved.width, saved.height, macos));
    }
    edge(screens, preferred, 240.0, 300.0, macos)
}

/// Native setters may be queued even when called on the main thread.
/// The adapter returns observed geometry; only confirmed operations may save.
pub(crate) trait PlacementAdapter {
    fn apply(&mut self, desired: &Layout) -> Result<(), String>;
    fn observed(&mut self) -> Option<Layout>;
    fn persist(&mut self, observed: &Layout);
}

#[derive(Debug, PartialEq)]
pub(crate) enum NativePosition {
    Logical(f64, f64),
    Physical(i32, i32),
}

pub(crate) fn native_position(layout: &Layout, macos: bool) -> NativePosition {
    if macos {
        // Tao converts PhysicalPosition with the CURRENT window's scale. The
        // monitor work-area origin carries the DESTINATION scale, so pass Cocoa
        // logical coordinates directly when crossing displays of different DPI.
        NativePosition::Logical(layout.x / layout.scale, layout.y / layout.scale)
    } else {
        NativePosition::Physical(layout.x.round() as i32, layout.y.round() as i32)
    }
}

pub(crate) fn zoom(screen: &Screen, current: &Layout, factor: f64, macos: bool) -> Option<Layout> {
    if !screen.valid() || !factor.is_finite() || factor <= 0.0
        || ![current.x, current.y, current.width, current.height].iter().all(|v| v.is_finite())
        || current.width <= 0.0 || current.height <= 0.0 { return None; }
    let width = (current.width * factor).clamp(200.0, 600.0);
    let height = (current.height * factor).clamp(250.0, 750.0);
    Some(fit(screen, (current.x - screen.x) / screen.scale, (current.y - screen.y) / screen.scale, width, height, macos))
}

pub(crate) const COMPLETION_ATTEMPTS: usize = 25;

fn geometry_matches(desired: &Layout, observed: &Layout, macos: bool) -> bool {
    if ![observed.x, observed.y, observed.width, observed.height, observed.scale].iter().all(|v| v.is_finite())
        || observed.scale <= 0.0 || (observed.scale - desired.scale).abs() > 1e-6 { return false; }
    let (desired_x, desired_y, actual_x, actual_y, tolerance) = if macos {
        (desired.x / desired.scale, desired.y / desired.scale, observed.x / observed.scale, observed.y / observed.scale, 1.0 / desired.scale)
    } else { (desired.x, desired.y, observed.x, observed.y, 1.0) };
    (desired_x - actual_x).abs() <= tolerance && (desired_y - actual_y).abs() <= tolerance
        && (desired.width - observed.width).abs() <= 0.5 / desired.scale + 1e-6
        && (desired.height - observed.height).abs() <= 0.5 / desired.scale + 1e-6
}

pub(crate) async fn apply_confirmed<A, W, F>(adapter: &mut A, desired: &Layout, macos: bool, persist: bool, mut wait: W) -> Result<(), String>
where A: PlacementAdapter, W: FnMut() -> F, F: std::future::Future<Output = ()> {
    adapter.apply(desired)?;
    // Setters may only enqueue an operation. Yield before every observation;
    // never restore from an immediate stale read or persist an unconfirmed one.
    for _ in 0..COMPLETION_ATTEMPTS {
        wait().await;
        if let Some(observed) = adapter.observed() {
            if geometry_matches(desired, &observed, macos) {
                if persist { adapter.persist(&observed); }
                return Ok(());
            }
        }
    }
    Err("companion placement did not settle before timeout".to_string())
}

pub(crate) fn load(path: &Path) -> Option<Placement> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES { return None; }
    let placement: Placement = serde_json::from_slice(&bytes).ok()?;
    placement.valid().then_some(placement)
}

/// Write beside the destination, flush, then atomically replace it. Errors are
/// returned only to the best-effort caller; an existing good file stays intact.
pub(crate) fn save(path: &Path, placement: &Placement) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Write};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    if !placement.valid() { return Err(Error::new(ErrorKind::InvalidData, "invalid companion placement")); }
    let parent = path.parent().ok_or_else(|| Error::new(ErrorKind::InvalidInput, "no placement parent"))?;
    std::fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec(placement)?;
    let temporary = parent.join(format!(".companion-placement-{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)?;
        // A directory sync is useful on Unix but unsupported by some filesystems.
        #[cfg(unix)]
        if let Ok(dir) = std::fs::File::open(parent) { let _ = dir.sync_all(); }
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-directory MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH. Never
    // delete the old preference first (std::fs::rename cannot replace on Windows).
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("cc-placement-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&p).unwrap(); Self(p)
        }
        fn file(&self) -> std::path::PathBuf { self.0.join("ui").join(FILE_NAME) }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn screen() -> Screen { Screen { name: Some("left".into()), x: -1920.0, y: -100.0, width: 1920.0, height: 1080.0, scale: 1.0 } }
    fn saved() -> Placement { Placement { version: 1, screen: screen(), left: 120.0, top: 80.0, width: 240.0, height: 300.0 } }
    fn layout() -> Layout { Layout { x: -1800.0, y: -20.0, width: 240.0, height: 300.0, scale: 1.0 } }

    #[test]
    fn preserves_valid_negative_monitor_position_and_logical_size() {
        assert_eq!(restore(Some(&saved()), &[screen()], 0, false), Some(layout()));
        assert_eq!(capture(&screen(), &layout(), true, false), Some(saved()));
    }
    #[test]
    fn capture_normalizes_native_pixel_rounding_but_preferences_keep_strict_size_limits() {
        let rounded = Layout { width: 600.25, height: 249.75, ..layout() };
        let captured = capture(&screen(), &rounded, true, false).unwrap();
        assert_eq!((captured.width, captured.height), (600.0, 250.0));
        assert_eq!(restore(Some(&captured), &[screen()], 0, false).unwrap().width, 600.0);
        let stale = Placement { width: 600.25, ..saved() };
        assert_eq!(restore(Some(&stale), &[screen()], 0, false).unwrap().width, 240.0);
    }
    #[test]
    fn ignores_minimized_hidden_nonfinite_or_bad_size_capture() {
        for (visible, minimized) in [(false, false), (true, true)] { assert!(capture(&screen(), &layout(), visible, minimized).is_none()); }
        for bad in [Layout { x: f64::NAN, ..layout() }, Layout { width: 0.0, ..layout() }, Layout { height: 751.0, ..layout() }, Layout { x: 9000.0, ..layout() }] {
            assert!(capture(&screen(), &bad, true, false).is_none());
        }
    }
    #[test]
    fn rejects_malformed_nonfinite_stale_and_out_of_bounds_preferences() {
        let tmp = Temp::new(); let path = tmp.file(); std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for body in ["", "not json", "{}", "{\"version\":1}", "null", "[]"] { std::fs::write(&path, body).unwrap(); assert!(load(&path).is_none()); }
        for bad in [Placement { version: 2, ..saved() }, Placement { left: f64::INFINITY, ..saved() }, Placement { left: -1.0, ..saved() }, Placement { top: 1000.0, ..saved() }, Placement { width: 601.0, ..saved() }, Placement { height: 249.0, ..saved() }, Placement { screen: Screen { scale: 0.0, ..screen() }, ..saved() }] {
            let fallback = restore(Some(&bad), &[screen()], 0, false).unwrap();
            assert_eq!(fallback, Layout { x: -256.0, y: 664.0, width: 240.0, height: 300.0, scale: 1.0 });
            assert!(save(&path, &bad).is_err());
        }
    }
    #[test]
    fn removed_monitor_moves_to_preferred_current_work_area() {
        let primary = Screen { name: Some("primary".into()), x: 0.0, y: 24.0, width: 1280.0, height: 696.0, scale: 1.0 };
        assert_eq!(restore(Some(&saved()), &[primary], 0, false), Some(Layout { x: 120.0, y: 104.0, width: 240.0, height: 300.0, scale: 1.0 }));
    }
    #[test]
    fn restores_matching_monitor_even_when_primary_is_elsewhere() {
        let primary = Screen { name: Some("primary".into()), x: 0.0, ..screen() };
        assert_eq!(restore(Some(&saved()), &[primary, screen()], 0, false), Some(layout()));
    }
    #[test]
    fn changed_dpi_uses_saved_logical_offsets_and_clamps_visible_size() {
        let changed = Screen { width: 900.0, height: 800.0, scale: 2.0, ..screen() };
        let remembered = Placement { left: 1300.0, top: 600.0, width: 500.0, height: 400.0, ..saved() };
        assert_eq!(restore(Some(&remembered), &[changed], 0, false), Some(Layout { x: -1920.0, y: -100.0, width: 450.0, height: 400.0, scale: 2.0 }));
    }
    #[test]
    fn small_monitor_keeps_minimum_bounds_and_top_right_controls() {
        let tiny = Screen { width: 180.0, height: 200.0, ..screen() };
        assert_eq!(restore(None, &[tiny], 0, false), Some(Layout { x: -1940.0, y: -100.0, width: 200.0, height: 250.0, scale: 1.0 }));
    }
    #[test]
    fn edge_reset_preserves_zoom_size_and_uses_visible_work_area() {
        assert_eq!(edge(&[screen()], 0, 320.0, 400.0, false), Some(Layout { x: -336.0, y: 564.0, width: 320.0, height: 400.0, scale: 1.0 }));
    }
    #[test]
    fn no_usable_monitor_does_not_invent_invalid_coordinates() {
        assert!(restore(Some(&saved()), &[], 0, false).is_none());
        assert!(restore(None, &[Screen { scale: f64::NAN, ..screen() }], 0, false).is_none());
    }
    #[test]
    fn captures_partial_offscreen_window_clamped_into_work_area() {
        let result = capture(&screen(), &Layout { x: -1980.0, y: 900.0, ..layout() }, true, false).unwrap();
        assert_eq!((result.left, result.top), (0.0, 780.0));
    }
    #[test]
    fn atomic_replacement_roundtrips_and_leaves_no_temporary_files() {
        let tmp = Temp::new(); let path = tmp.file();
        save(&path, &saved()).unwrap(); assert_eq!(load(&path), Some(saved()));
        let next = Placement { width: 320.0, height: 400.0, ..saved() };
        save(&path, &next).unwrap(); assert_eq!(load(&path), Some(next.clone()));
        assert!(save(&path, &Placement { width: 900.0, ..saved() }).is_err());
        assert_eq!(load(&path), Some(next));
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn failed_destination_does_not_leave_partial_preference() {
        let tmp = Temp::new(); let path = tmp.file(); std::fs::create_dir_all(&path).unwrap();
        assert!(save(&path, &saved()).is_err()); assert!(load(&path).is_none());
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn unreadable_oversized_and_unknown_field_preferences_are_ignored() {
        let tmp = Temp::new(); let path = tmp.file(); assert!(load(&path).is_none());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, " ".repeat(16385)).unwrap(); assert!(load(&path).is_none());
        let mut value = serde_json::to_value(saved()).unwrap(); value["extra"] = true.into();
        std::fs::write(&path, value.to_string()).unwrap(); assert!(load(&path).is_none());
    }
    #[test]
    fn concurrent_atomic_writes_leave_a_complete_valid_document() {
        let tmp = Temp::new(); let path = tmp.file();
        let threads: Vec<_> = (0..8).map(|i| { let path = path.clone(); std::thread::spawn(move || save(&path, &Placement { left: i as f64, ..saved() }).unwrap()) }).collect();
        for thread in threads { thread.join().unwrap(); }
        let value = load(&path).unwrap(); assert!((0.0..8.0).contains(&value.left));
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    fn run_ready<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(output) => output,
            std::task::Poll::Pending => panic!("test wait must be ready"),
        }
    }

    #[derive(Default)]
    struct QueuedState {
        current: Option<Layout>,
        pending: Option<Layout>,
        applied: Vec<Layout>,
        persisted: Vec<Layout>,
        waits: usize,
    }
    struct QueuedAdapter(std::rc::Rc<std::cell::RefCell<QueuedState>>, bool);
    impl PlacementAdapter for QueuedAdapter {
        fn apply(&mut self, desired: &Layout) -> Result<(), String> {
            let mut state = self.0.borrow_mut();
            let current_scale = state.current.as_ref().unwrap().scale;
            let (x, y) = match native_position(desired, self.1) {
                NativePosition::Logical(x, y) => (x * desired.scale, y * desired.scale),
                NativePosition::Physical(x, y) if self.1 => (f64::from(x) / current_scale * desired.scale, f64::from(y) / current_scale * desired.scale),
                NativePosition::Physical(x, y) => (f64::from(x), f64::from(y)),
            };
            // Native QA: AppKit ceils fractional point sizes, including a
            // floating epsilon above an integer. Tao forwards these unchanged.
            let (width, height) = if self.1 { (desired.width.ceil(), desired.height.ceil()) } else { (desired.width, desired.height) };
            state.pending = Some(Layout { x, y, width, height, ..desired.clone() });
            state.applied.push(desired.clone());
            Ok(())
        }
        fn observed(&mut self) -> Option<Layout> { self.0.borrow().current.clone() }
        fn persist(&mut self, observed: &Layout) { self.0.borrow_mut().persisted.push(observed.clone()); }
    }
    fn queued(current: Layout, macos: bool) -> QueuedAdapter {
        QueuedAdapter(std::rc::Rc::new(std::cell::RefCell::new(QueuedState { current: Some(current), ..Default::default() })), macos)
    }

    #[test]
    fn zoom_derives_clamped_desired_layout_without_reading_pending_native_size() {
        let current = Layout { x: -256.0, y: 664.0, ..layout() };
        let desired = zoom(&screen(), &current, 1.12, false).unwrap();
        assert!((desired.width - 268.8).abs() < 1e-9);
        assert!((desired.height - 336.0).abs() < 1e-9);
        assert!((desired.x + 268.8).abs() < 1e-9);
        assert!((desired.y - 644.0).abs() < 1e-9);
    }

    #[test]
    fn queued_zoom_waits_for_actual_requested_geometry_before_saving() {
        let mut adapter = queued(layout(), true);
        let state = adapter.0.clone();
        let desired = zoom(&screen(), &layout(), 1.12, true).unwrap();
        run_ready(apply_confirmed(&mut adapter, &desired, true, true, || {
            let mut state = state.borrow_mut();
            assert!(state.persisted.is_empty());
            state.waits += 1;
            if state.waits == 2 { state.current = state.pending.take(); }
            std::future::ready(())
        })).unwrap();
        let state = state.borrow();
        assert_eq!(state.waits, 2);
        assert_eq!(state.applied, vec![desired.clone()]);
        assert_eq!(state.persisted, vec![desired]);
    }

    #[test]
    fn queued_reset_saves_new_origin_immediately_after_confirmed_operation_not_close() {
        let mut adapter = queued(layout(), true);
        let state = adapter.0.clone();
        let desired = edge(&[screen()], 0, 240.0, 300.0, false).unwrap();
        run_ready(apply_confirmed(&mut adapter, &desired, true, true, || {
            let mut state = state.borrow_mut();
            assert!(state.persisted.is_empty());
            state.waits += 1;
            state.current = state.pending.take();
            std::future::ready(())
        })).unwrap();
        let state = state.borrow();
        assert_eq!(state.persisted.len(), 1);
        assert_eq!((state.persisted[0].x, state.persisted[0].y), (-256.0, 664.0));
    }

    #[test]
    fn unconfirmed_or_superseded_native_operation_times_out_without_saving() {
        let mut adapter = queued(layout(), true);
        let state = adapter.0.clone();
        let desired = Layout { width: 320.0, height: 400.0, ..layout() };
        let result = run_ready(apply_confirmed(&mut adapter, &desired, true, true, || {
            state.borrow_mut().waits += 1;
            std::future::ready(())
        }));
        assert!(result.is_err());
        let state = state.borrow();
        assert_eq!(state.waits, COMPLETION_ATTEMPTS);
        assert_eq!(state.applied.len(), 1);
        assert!(state.persisted.is_empty());
    }

    #[test]
    fn macos_mapping_reaches_destination_when_current_and_destination_dpi_differ() {
        for (current_scale, destination_scale, x, y) in [(1.0, 2.0, 3840.0, 200.0), (2.0, 1.0, -1920.0, -100.0)] {
            let mut adapter = queued(Layout { scale: current_scale, ..layout() }, true);
            let state = adapter.0.clone();
            let desired = Layout { scale: destination_scale, x, y, ..layout() };
            run_ready(apply_confirmed(&mut adapter, &desired, true, false, || {
                let mut state = state.borrow_mut();
                if let Some(pending) = state.pending.take() { state.current = Some(pending); }
                std::future::ready(())
            })).unwrap();
            assert_eq!(state.borrow().current, Some(desired));
            assert!(state.borrow().persisted.is_empty());
        }
    }

    #[test]
    fn windows_adapter_retains_physical_global_coordinates_across_dpi_changes() {
        let desired = Layout { scale: 2.0, x: 3840.0, y: 200.0, ..layout() };
        assert_eq!(native_position(&desired, false), NativePosition::Physical(3840, 200));
    }


    fn retina_screen() -> Screen {
        Screen { x: 0.0, y: 0.0, width: 3024.0, height: 1780.0, scale: 2.0, ..screen() }
    }
    fn flush_queued(adapter: &mut QueuedAdapter, desired: &Layout) -> Result<(), String> {
        let state = adapter.0.clone();
        run_ready(apply_confirmed(adapter, desired, true, true, || {
            let mut state = state.borrow_mut();
            state.waits += 1;
            if let Some(pending) = state.pending.take() { state.current = Some(pending); }
            std::future::ready(())
        }))
    }

    #[test]
    fn macos_queued_zoom_normalizes_point_sizes_before_appkit_ceil_and_saves() {
        let screen = retina_screen();
        let current = Layout { scale: 2.0, x: 200.0, y: 200.0, ..layout() };
        let mut adapter = queued(current.clone(), true);
        let desired = zoom(&screen, &current, 1.12, true).unwrap();
        // Real native receipt before normalization: 269 x 337, not the raw
        // 268.8 x 336.00000000000006. Request integral points instead.
        flush_queued(&mut adapter, &desired).unwrap();
        let state = adapter.0.borrow();
        let actual = state.current.as_ref().unwrap();
        assert_eq!((actual.width, actual.height), (269.0, 336.0));
        assert_eq!(state.persisted, vec![actual.clone()]);
        let temp = Temp::new();
        save(&temp.file(), &capture(&screen, actual, true, false).unwrap()).unwrap();
        let recorded = load(&temp.file()).unwrap();
        assert_eq!((recorded.width, recorded.height), (269.0, 336.0));
    }

    #[test]
    fn macos_point_quantized_zoom_in_out_sequence_roundtrips_and_continues() {
        let screen = retina_screen();
        let mut adapter = queued(Layout { scale: 2.0, x: 200.0, y: 200.0, ..layout() }, true);
        for (factor, width, height) in [(1.12, 269.0, 336.0), (1.0 / 1.12, 240.0, 300.0), (1.12, 269.0, 336.0), (1.12, 301.0, 376.0)] {
            let current = adapter.0.borrow().current.clone().unwrap();
            let desired = zoom(&screen, &current, factor, true).unwrap();
            flush_queued(&mut adapter, &desired).unwrap();
            let state = adapter.0.borrow();
            assert_eq!((state.current.as_ref().unwrap().width, state.current.as_ref().unwrap().height), (width, height));
            assert_eq!(state.persisted.last(), state.current.as_ref());
        }
        assert_eq!(adapter.0.borrow().persisted.len(), 4);
    }

    #[test]
    fn macos_point_quantized_zoom_respects_min_max_and_work_area_limits() {
        let screen = retina_screen();
        for (width, height, factor, expected_width, expected_height) in [
            (590.0, 740.0, 1.12, 600.0, 750.0), (600.0, 750.0, 1.12, 600.0, 750.0),
            (600.0, 750.0, 1.0 / 1.12, 536.0, 670.0), (210.0, 260.0, 1.0 / 1.12, 200.0, 250.0),
            (200.0, 250.0, 1.0 / 1.12, 200.0, 250.0),
        ] {
            let current = Layout { scale: 2.0, x: 200.0, y: 200.0, width, height };
            let mut adapter = queued(current.clone(), true);
            let desired = zoom(&screen, &current, factor, true).unwrap();
            flush_queued(&mut adapter, &desired).unwrap();
            let state = adapter.0.borrow();
            assert_eq!((state.current.as_ref().unwrap().width, state.current.as_ref().unwrap().height), (expected_width, expected_height));
            assert_eq!(state.persisted.last(), state.current.as_ref());
        }
        let fraction = Screen { width: 1001.0, height: 1001.0, ..screen };
        let desired = edge(&[fraction], 0, 500.25, 500.25, true).unwrap();
        assert_eq!((desired.width, desired.height), (500.0, 500.0));
    }

    #[test]
    fn normalized_request_still_rejects_a_whole_point_size_mismatch() {
        let current = Layout { scale: 2.0, x: 200.0, y: 200.0, ..layout() };
        let mut adapter = queued(current.clone(), true);
        let state = adapter.0.clone();
        let desired = zoom(&retina_screen(), &current, 1.12, true).unwrap();
        let result = run_ready(apply_confirmed(&mut adapter, &desired, true, true, || {
            let mut state = state.borrow_mut();
            state.waits += 1;
            if let Some(mut pending) = state.pending.take() { pending.height += 1.0; state.current = Some(pending); }
            std::future::ready(())
        }));
        assert!(result.is_err());
        assert_eq!(state.borrow().waits, COMPLETION_ATTEMPTS);
        assert!(state.borrow().persisted.is_empty());
    }

}
