import AppKit
import WebKit

/// The chat window: a floating, draggable panel whose content is the web UI in
/// `Resources/ui.html`.
///
/// The composer is a real web composer on purpose — pasting text, images and
/// files, drag-and-drop, and rich rendering are things the web platform already
/// does well; re-implementing them in AppKit would be a permanent tax for a
/// worse result.
final class QuickAskController: NSObject, WKNavigationDelegate, WKScriptMessageHandler, PasteHandling, NSWindowDelegate {

    private let panel: ChatPanel
    private let webView: WKWebView
    private var loaded = false
    private var pendingBootstrap: String?

    /// `native` renders Resources/ui.html; `embedded` boots the host's own GUI
    /// inside the window so its real components (chat, tool cards, approvals,
    /// themes) are used instead of ours.
    /// Surface choice: env wins for testing, otherwise the stored preference.
    private var embedded = ProcessInfo.processInfo.environment["DSH_MENUBAR_UI"] != "native"
    private var appURL: URL?
    private var pasteMonitor: Any?
    private var concealTask: Task<Void, Never>?
    private let closeOverlay = NSButton()
    private var lastCloseAt = Date.distantPast
    var closedRecently: Bool { Date().timeIntervalSince(lastCloseAt) < 0.25 }
    var isShown: Bool { panel.isVisible }

    override init() {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        config.userContentController = controller
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let frame = NSRect(x: 0, y: 0, width: 640, height: 580)
        panel = ChatPanel(contentRect: frame, styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        panel.minSize = NSSize(width: 460, height: 420)
        webView = WKWebView(frame: frame, configuration: config)

        super.init()

        controller.add(self, name: "dsh")
        panel.pasteTarget = self

        // Capture page errors from the embedded GUI: a failing boot entry only
        // reports "1 entry did not activate" in the UI, not the reason.
        let errorHook = WKUserScript(source: #"""
        (() => {
          const post = (message) => {
            try { window.webkit.messageHandlers.dsh.postMessage({ type: 'log', message: 'page: ' + message }); } catch (_) {}
          };
          window.addEventListener('error', (e) => post('error ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)));
          window.addEventListener('unhandledrejection', (e) => post('rejection ' + String(e.reason)));
          window.dshInsertText = (text) => {
            const el = document.activeElement;
            if (!el) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              const start = el.selectionStart == null ? el.value.length : el.selectionStart;
              const end = el.selectionEnd == null ? start : el.selectionEnd;
              el.value = el.value.slice(0, start) + text + el.value.slice(end);
              el.selectionStart = el.selectionEnd = start + text.length;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
            if (el.isContentEditable) {
              return document.execCommand('insertText', false, text);
            }
            return false;
          };
          window.addEventListener('paste', (e) => {
            const files = e.clipboardData && e.clipboardData.files ? e.clipboardData.files.length : -1;
            const text = e.clipboardData ? (e.clipboardData.getData('text/plain') || '').slice(0, 40) : '';
            post('paste event files=' + files + ' text=' + JSON.stringify(text));
          }, true);
          window.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'v') {
              const el = document.activeElement;
              post('cmd-v target=' + (el ? el.tagName + '.' + String(el.className || '').slice(0, 30) : 'none'));
            }
          }, true);
          for (const level of ['warn', 'log']) {
            const originalLevel = console[level];
            console[level] = function (...args) {
              const text = args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ');
              if (/menubar|boot|activat|plugin/i.test(text)) post('console.' + level + ' ' + text.slice(0, 500));
              originalLevel.apply(console, args);
            };
          }
          const original = console.error;
          console.error = function (...args) {
            post('console.error ' + args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ').slice(0, 600));
            original.apply(console, args);
          };
        })();
        """#, injectionTime: .atDocumentStart, forMainFrameOnly: true)

        // A local monitor runs before the event is dispatched, so ⌘V cannot be
        // swallowed by WebKit's DOM paste handling (which reports no files for
        // a file:// page). Returning nil consumes the event.
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.panel.isVisible else { return event }
            let isPaste = event.modifierFlags.contains(.command)
                && event.charactersIgnoringModifiers?.lowercased() == "v"
            debugLog("monitor key: \(event.charactersIgnoringModifiers ?? "?") cmd=\(event.modifierFlags.contains(.command))")
            guard isPaste else { return event }
            return self.handlePaste() ? nil : event
        }

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false

        let container = NSView(frame: frame)
        container.wantsLayer = true
        container.layer?.cornerRadius = 16
        container.layer?.masksToBounds = true
        container.autoresizingMask = [.width, .height]
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        container.addSubview(webView)
        panel.contentView = container

        // The embedded GUI has no window chrome, so the close control lives
        // here; it is hidden in native mode, where the page draws its own.
        closeOverlay.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
        closeOverlay.isBordered = false
        closeOverlay.contentTintColor = .secondaryLabelColor
        closeOverlay.target = self
        closeOverlay.action = #selector(closeClicked)
        closeOverlay.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(closeOverlay)
        NSLayoutConstraint.activate([
            closeOverlay.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            closeOverlay.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
            closeOverlay.widthAnchor.constraint(equalToConstant: 20),
            closeOverlay.heightAnchor.constraint(equalToConstant: 20),
        ])

        // Title strip is draggable; it stops short of the close button so that
        // control keeps receiving clicks.
        let drag = DragHandle(frame: .zero)
        drag.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(drag)
        NSLayoutConstraint.activate([
            drag.topAnchor.constraint(equalTo: container.topAnchor),
            drag.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            drag.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -56),
            drag.heightAnchor.constraint(equalToConstant: embedded ? 12 : 38),
        ])

        panel.dragBandHeight = embedded ? 12 : 38
        panel.delegate = self
        if embedded { config.userContentController.addUserScript(errorHook) }
        webView.navigationDelegate = self
        closeOverlay.isHidden = !embedded
        if !embedded { loadPage() }
    }

    deinit {
        if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
    }

    func windowDidMove(_ notification: Notification) {
        debugLog("window moved to \(panel.frame.origin)")
    }

    // MARK: - Page

    private func loadPage() {
        guard let url = Bundle.module.url(forResource: "ui", withExtension: "html") else {
            debugLog("ui.html missing from bundle")
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        if embedded {
            // The GUI mounts its React tree after the document finishes loading,
            // so chrome-hiding has to be retried until the shell is up.
            // Chrome-hiding is disabled: guessing at the shell's internals
            // collapsed the layout. Report the real viewport instead.
            concealTask?.cancel()
            concealTask = Task { [weak self] in
                for attempt in 0..<3 {
                    if Task.isCancelled { return }
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    await MainActor.run { self?.reportViewport(tag: "boot #\(attempt)") }
                }
            }
            return
        }
        if let pending = pendingBootstrap {
            evaluate(pending)
            pendingBootstrap = nil
        }
        debugLog("web ui loaded")
    }

    /// Log the page's viewport against the window, so a layout mismatch is
    /// visible in the log instead of guessed at.
    private func reportViewport(tag: String) {
        let script = #"""
        JSON.stringify({
          innerW: window.innerWidth, innerH: window.innerHeight,
          kids: [...document.body.children].map((el) => {
            const r = el.getBoundingClientRect();
            return (el.tagName + '.' + String(el.className || '')).slice(0, 40)
              + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
              + '@' + Math.round(r.left) + ',' + Math.round(r.top);
          }),
          sidebarVisible: [...document.querySelectorAll('aside, [class*="sidebar"], [class*="Sidebar"]')]
            .some((el) => el.getBoundingClientRect().width > 100),
          composer: (() => {
            const el = document.querySelector('textarea, [contenteditable="true"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, x: Math.round(r.left), y: Math.round(r.top),
                     w: Math.round(r.width), h: Math.round(r.height),
                     focused: document.activeElement === el,
                     text: String(el.innerText || el.value || '').slice(0, 40) };
          })(),
        })
        """#
        webView.evaluateJavaScript(script) { value, error in
            if let error {
                debugLog("\(tag) viewport error: \(error.localizedDescription)")
            } else {
                debugLog("\(tag) window=\(self.panel.frame.size) viewport=\(value ?? "?")")
            }
        }
    }

    func windowDidResize(_ notification: Notification) {
        debugLog("window resized to \(panel.frame.size)")
        reportViewport(tag: "resize")
    }

    /// Hide the GUI's own navigation so the window shows the conversation only.
    /// Retried because the tree is mounted asynchronously.
    private func concealChrome(attempt: Int) {
        let script = #"""
        (() => {
          const report = { hid: 0, composer: false, text: '' };
          document.querySelectorAll('aside, nav, [class*="sidebar"], [class*="Sidebar"], [class*="SidebarRoot"]').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 200) { el.style.display = 'none'; report.hid += 1; }
          });
          report.composer = !!document.querySelector('textarea, [contenteditable="true"]');
          report.text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 100);
          if (\#(attempt) % 6 === 0 || report.composer) {
            window.webkit.messageHandlers.dsh.postMessage({
              type: 'log',
              message: 'conceal #\#(attempt) hid=' + report.hid + ' composer=' + report.composer + ' text=' + report.text,
            });
          }
          return report;
        })();
        """#
        webView.evaluateJavaScript(script) { _, error in
            if let error { debugLog("conceal js error: \(error.localizedDescription)") }
        }
    }

    private func evaluate(_ script: String) {
        webView.evaluateJavaScript(script) { _, error in
            if let error { debugLog("js error: \(error.localizedDescription)") }
        }
    }

    /// Hand the page its token and bridge URL, then let it connect.
    func configure(wsURL: String, token: String, workspacePath: String, appUrl: String?, embedded requested: Bool?) {
        if let requested, ProcessInfo.processInfo.environment["DSH_MENUBAR_UI"] == nil {
            embedded = requested
            panel.dragBandHeight = embedded ? 12 : 38
        }
        closeOverlay.isHidden = !embedded
        if embedded, let appUrl, let url = URL(string: appUrl) {
            appURL = url
            closeOverlay.isHidden = false
            webView.load(URLRequest(url: url))
            debugLog("embedded ui: loading \(url.absoluteString.split(separator: "?").first ?? "?")")
            return
        }
        let config: [String: Any] = ["wsUrl": wsURL, "token": token, "workspacePath": workspacePath]
        guard let data = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let script = "window.dshBootstrap(\(json))"
        if loaded { evaluate(script) } else { pendingBootstrap = script }
    }

    // MARK: - Presentation

    func present() {
        centerNearTop()
        // An accessory app cannot reliably become the active app, and a web view
        // needs real key focus for typing and ⌘V. Promoting to `.regular` while
        // the window is open is the reliable way to claim focus; the Dock icon
        // disappears again when the window closes.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        if loaded {
            // Every reopen starts a fresh conversation: the window is sticky, so
            // "open it again" is the natural "new session" gesture.
            evaluate("window.dshReset && window.dshReset()")
            evaluate("window.dshFocus && window.dshFocus()")
        }
        debugLog("window shown at \(panel.frame)")
    }

    @objc private func closeClicked() { close() }

    func close() {
        lastCloseAt = Date()
        panel.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        debugLog("window closed")
    }

    private func centerNearTop() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2,
                                     y: visible.maxY - size.height - 110))
    }

    // MARK: - Page messages

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String
        else { return }
        switch type {
        case "close":
            close()
        case "log":
            debugLog("ui: \(body["message"] as? String ?? "")")
        case "answer":
            debugLog("ui answer: \(body["text"] as? String ?? "")")
        default:
            break
        }
    }

    // MARK: - Paste (native clipboard)

    /// Read `NSPasteboard` and hand the payload to the page.
    ///
    /// Order matters: an image dragged from a browser often also carries a
    /// string and a URL, and the image is what the user meant.
    func handlePaste() -> Bool {
        debugLog("handlePaste called; isShown=\(panel.isVisible) key=\(panel.isKeyWindow)")
        let pasteboard = NSPasteboard.general
        var payloads: [[String: Any]] = []

        let imageTypes: [NSPasteboard.PasteboardType] = [
            .png, .tiff, NSPasteboard.PasteboardType("public.jpeg"),
            NSPasteboard.PasteboardType("public.heic"),
        ]
        if let type = pasteboard.availableType(from: imageTypes),
           let data = pasteboard.data(forType: type) {
            let mediaType = type == .png ? "image/png" : "image/jpeg"
            let base64 = data.base64EncodedString()
            payloads.append([
                "kind": "image",
                "name": "pasted image",
                "mediaType": mediaType,
                "dataURL": "data:\(mediaType);base64,\(base64)",
            ])
        } else if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
                  !urls.isEmpty {
            for url in urls {
                if let image = NSImage(contentsOf: url),
                   let tiff = image.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    payloads.append([
                        "kind": "image",
                        "name": url.lastPathComponent,
                        "mediaType": "image/png",
                        "dataURL": "data:image/png;base64,\(png.base64EncodedString())",
                    ])
                } else if let text = try? String(contentsOf: url, encoding: .utf8), text.count < 20000 {
                    payloads.append(["kind": "file", "name": url.lastPathComponent, "text": text])
                } else {
                    payloads.append(["kind": "file", "name": url.lastPathComponent, "text": NSNull()])
                }
            }
        } else if let string = pasteboard.string(forType: .string) {
            payloads.append(["kind": "text", "text": string])
        }

        guard !payloads.isEmpty else {
            debugLog("native paste: nothing usable on the pasteboard")
            return false
        }

        if embedded {
            // The embedded shell owns its own paste pipeline, and a menu item
            // cannot drive it. Inject the text into whatever holds focus; image
            // parts would need the shell's upload route, so they are reported
            // rather than silently dropped.
            let text = payloads.compactMap { $0["kind"] as? String == "text" ? $0["text"] as? String : nil }.first
            let nonText = payloads.filter { ($0["kind"] as? String) != "text" }.count
            if nonText > 0 {
                debugLog("embedded paste: \(nonText) non-text item(s) ignored — paste images in the dsh browser window")
            }
            guard let text, !text.isEmpty else { return false }
            if let data = try? JSONSerialization.data(withJSONObject: [text]),
               let json = String(data: data, encoding: .utf8),
               let array = (try? JSONSerialization.jsonObject(with: data)) as? [String],
               let first = array.first {
                _ = json
                let escaped = first
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\n", with: "\\n")
                evaluate("window.dshInsertText && window.dshInsertText(\"\(escaped)\")")
                debugLog("embedded paste: injected \(first.count) chars")
                return true
            }
            return false
        }
        debugLog("native paste: \(payloads.map { $0["kind"] as? String ?? "?" }.joined(separator: ","))")
        guard let data = try? JSONSerialization.data(withJSONObject: payloads),
              let json = String(data: data, encoding: .utf8)
        else { return false }
        evaluate("window.dshNativePaste ? window.dshNativePaste(\(json)) : null")
        return true
    }

    /// Automation hook used for headless verification.
    func evaluateForTesting(_ script: String, completion: @escaping (Any?, Error?) -> Void) {
        webView.evaluateJavaScript(script) { value, error in completion(value, error) }
    }
}

/// Native drag strip.
///
/// `-webkit-app-region: drag` is an Electron feature — WKWebView ignores it and
/// swallows the mouse, so background dragging never reaches the window. A thin
/// AppKit view over the title strip restores normal window dragging.
final class DragHandle: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

/// Anything that can service a paste for a panel.
protocol PasteHandling: AnyObject {
    /// Handle ⌘V from the real pasteboard.
    /// - Returns: true when the panel consumed the shortcut.
    func handlePaste() -> Bool
}

/// Escape closes the window even when the page holds focus, and ⌘V is
/// intercepted here.
///
/// WebKit's paste event does not reliably expose image and file clipboard
/// payloads to a file:// page, so the panel reads `NSPasteboard` itself and
/// injects the result into the page. Text, images and file URLs all take the
/// same path, and the page never needs a clipboard permission.
final class ChatPanel: NSPanel {
    weak var pasteTarget: PasteHandling?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        close()
    }

    /// Drag from the title strip, before the web view can consume the press.
    ///
    /// Overlay views lose the hit-test to a WKWebView, so the strip is handled
    /// here: a left press in the top band (short of the close button) becomes a
    /// window drag instead of a page interaction.
    /// Height of the draggable title band. The embedded GUI draws its own
    /// header, so it gets a thin strip; our own page can spare the full row.
    var dragBandHeight: CGFloat = 38

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown {
            let point = event.locationInWindow
            let inStrip = point.y > frame.height - dragBandHeight && point.x < frame.width - 56
            if inStrip {
                performDrag(with: event)
                return
            }
        }
        super.sendEvent(event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // ⌘V belongs to the local monitor in QuickAskController, which runs
        // before key equivalents reach this view. Handling it here as well made
        // a single keystroke paste three times.
        super.performKeyEquivalent(with: event)
    }
}

/// Optional stderr tracing, enabled with DSHBRIDGE_DEBUG=1.
func debugLog(_ message: String) {
    guard ProcessInfo.processInfo.environment["DSHBRIDGE_DEBUG"] == "1" else { return }
    FileHandle.standardError.write("dshmenubar: \(message)\n".data(using: .utf8)!)
}
