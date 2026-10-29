import AppKit

// Menu-bar-only app: accessory activation policy means no Dock icon and no
// main window; the only surface is the NSStatusItem plus the quick-ask panel.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate

app.run()
