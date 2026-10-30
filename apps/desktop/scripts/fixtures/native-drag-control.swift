// Offline native-input control. Run only in the dedicated Mac mini UI lab.
import AppKit

let output: FileHandle = {
  guard let path = ProcessInfo.processInfo.environment["CC_UI_CONTROL_LOG"] else { return .standardOutput }
  let file = URL(fileURLWithPath: path).standardizedFileURL
  let lab = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("cc-ui-lab").path + "/"
  precondition(file.path.hasPrefix(lab), "Control log must stay in the UI lab")
  if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
  let handle = try! FileHandle(forWritingTo: file)
  try! handle.seekToEnd()
  return handle
}()

func report(_ event: String, view: NSView, input: NSEvent? = nil) {
  guard let window = view.window else { return }
  let frame = window.frame, cursor = NSEvent.mouseLocation
  var value: [String: Any] = ["event": event, "title": window.title,
    "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
    "cursor": ["x": cursor.x, "y": cursor.y], "buttons": NSEvent.pressedMouseButtons,
    "targetWindowNumber": window.windowNumber, "movable": window.isMovable,
    "visible": window.isVisible, "key": window.isKeyWindow]
  if let input {
    value["nativeType"] = input.type.rawValue
    value["windowNumber"] = input.windowNumber
    value["timestamp"] = input.timestamp
  }
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  output.write(data + Data([10]))
}

final class DragArea: NSView {
  let usesNativeGesture: Bool
  var origin: NSPoint?
  var cursor: NSPoint?

  init(frame: NSRect, native: Bool) {
    usesNativeGesture = native
    super.init(frame: frame)
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel(native ? "Native gesture control" : "Event tracking control")
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func draw(_ rect: NSRect) {
    (usesNativeGesture ? NSColor.systemOrange : NSColor.systemBlue).setFill()
    bounds.fill()
    let title = usesNativeGesture ? "Native gesture" : "Event tracking"
    (title as NSString).draw(at: NSPoint(x: 18, y: 105), withAttributes: [.foregroundColor: NSColor.white])
  }
  override func mouseDown(with event: NSEvent) {
    report("down", view: self, input: event)
    if usesNativeGesture {
      window?.performDrag(with: event)
      report("native-returned", view: self)
    } else {
      origin = window?.frame.origin
      cursor = NSEvent.mouseLocation
    }
  }
  override func mouseDragged(with event: NSEvent) {
    guard let origin, let cursor else { return }
    let current = NSEvent.mouseLocation
    window?.setFrameOrigin(NSPoint(x: origin.x + current.x - cursor.x, y: origin.y + current.y - cursor.y))
    report("dragged", view: self, input: event)
  }
  override func mouseUp(with event: NSEvent) {
    report("up", view: self, input: event)
    origin = nil; cursor = nil
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 220, y: 380, width: 480, height: 240),
  styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "CC Native Input Control"
let content = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 240))
content.addSubview(DragArea(frame: NSRect(x: 0, y: 0, width: 240, height: 240), native: true))
content.addSubview(DragArea(frame: NSRect(x: 240, y: 0, width: 240, height: 240), native: false))
window.contentView = content
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
report("ready", view: content)
application.run()
