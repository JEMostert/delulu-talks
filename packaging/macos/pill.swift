import AppKit

// A non-activating panel keeps the insertion cursor in the original application.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 210, height: 38),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.isOpaque = false
panel.backgroundColor = .clear
panel.ignoresMouseEvents = true
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
let label = NSTextField(labelWithString: "")
label.alignment = .center
label.font = .systemFont(ofSize: 15, weight: .semibold)
label.textColor = .white
let background = NSView(frame: panel.contentView!.bounds)
background.wantsLayer = true
background.layer?.backgroundColor = NSColor(calibratedWhite: 0.12, alpha: 0.94).cgColor
background.layer?.cornerRadius = 19
label.frame = NSRect(x: 6, y: 9, width: 198, height: 21)
background.addSubview(label)
panel.contentView = background
var hide: DispatchWorkItem?
struct Message: Decodable { let state: String; let label: String?; let level: Double? }
DispatchQueue.global().async {
    while let line = readLine() {
        guard let message = try? JSONDecoder().decode(Message.self, from: Data(line.utf8)) else { continue }
        DispatchQueue.main.async {
            hide?.cancel()
            if message.state == "hidden" { panel.orderOut(nil); return }
            label.stringValue = message.label ?? message.state.capitalized
            if message.state == "listening", let level = message.level {
                label.stringValue += "  " + String(repeating: "▮", count: Int(min(1,max(0,level))*6))
            }
            if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) {
                panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 105, y: screen.visibleFrame.minY + 28))
            }
            panel.orderFrontRegardless()
            if ["success", "error"].contains(message.state) {
                let work = DispatchWorkItem { panel.orderOut(nil) }
                hide = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
            }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
