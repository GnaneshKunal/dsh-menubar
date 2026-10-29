import AppKit
import Foundation

/// Menu-bar controller: status item, popover-style chat window, global hotkey.
///
/// The window's content is a web view (see ChatWindow.swift), so this class only
/// owns the shell: the status item, the hotkey, connection lifecycle, and the
/// right-click menu.
final class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusItem: NSStatusItem!
    private var quickAsk: QuickAskController!
    private var menu: NSMenu!
    private var statusMenuItem: NSMenuItem!
    private let client = MenubarClient()
    private var hotKey: GlobalHotKey!

    private var connected = false
    private var connecting = false
    private var lastToggleAt = Date.distantPast

    // MARK: - Lifecycle

    /// Closing the window hides it; the status item lives on.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        quickAsk = QuickAskController()
        client.onDisconnect = { [weak self] in self?.handleConnectionLoss() }
        setupStatusItem()
        setupHotKey()
        connect()
    }

    func applicationWillTerminate(_ notification: Notification) {
        debugLog("terminating: socket closed, status item removed")
        client.disconnect()
    }

    /// A minimal main menu.
    ///
    /// Without an Edit menu there is no Paste command for the web view to
    /// answer, so ⌘V does nothing in the embedded surface — the shortcut is a
    /// menu key equivalent, not something the page can see on its own.
    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About dsh-menubar", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide dsh-menubar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit dsh-menubar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Menu bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            // The official mark, shipped with the plugin's web front end.
            if let url = Bundle.module.url(forResource: "whale", withExtension: "svg"),
               let whale = NSImage(contentsOf: url) {
                whale.size = NSSize(width: 18, height: 18)
                whale.isTemplate = true
                button.image = whale
                debugLog("status icon: whale svg loaded (18pt template)")
            } else if let image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "dsh") {
                debugLog("status icon: whale missing, fell back to sparkle")
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "◈"
            }
            button.toolTip = "DSH quick ask  ⌃⌥Q"
            button.target = self
            button.action = #selector(buttonClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "connecting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Ask dsh…", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(withTitle: "Reconnect", action: #selector(reconnect), keyEquivalent: "r")
        menu.addItem(withTitle: "Open DSH in browser", action: #selector(openGUI), keyEquivalent: "o")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit DSH Quick Ask", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
    }

    @objc private func buttonClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        toggleWindow()
    }

    private func setupHotKey() {
        hotKey = GlobalHotKey()
        if !hotKey.register(callback: { [weak self] in self?.toggleWindow() }) {
            statusMenuItem?.title = "hotkey unavailable"
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func openGUI() {
        if let url = URL(string: "http://127.0.0.1:3080") { NSWorkspace.shared.open(url) }
    }
    @objc private func reconnect() {
        client.disconnect()
        connected = false
        connect()
    }
    @objc private func showWindow() { toggleWindow() }

    // MARK: - Connection

    private func connect() {
        guard !connecting else { return }
        if connected { return }   // a live socket already exists
        connecting = true
        updateStatus("connecting…")

        Task {
            do {
                try await client.connect()
                let token = try client.sharedToken()
                let url = client.connectedURL ?? ""
                let workspace = client.workspacePath
                // Read the stored surface preference before touching the UI.
                let prefs = (try? await self.client.prefs()) ?? [:]
                let embedded = (prefs["ui"] as? String) == "embedded"
                let appUrl = client.discoveryPayload["appUrl"] as? String

                await MainActor.run {
                    self.connected = true
                    self.connecting = false
                    self.updateStatus("connected · \(workspace)")
                    // Hand the page its credentials once; it owns the socket
                    // from here so every RPC is plain JS.
                    self.quickAsk.configure(wsURL: url, token: token, workspacePath: workspace,
                                            appUrl: appUrl, embedded: embedded)
                }
            } catch {
                await MainActor.run {
                    self.connected = false
                    self.connecting = false
                    self.updateStatus("offline · \(error.localizedDescription)")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.connect() }
                }
            }
        }
    }

    /// Reconnect when the host goes away, and rebind the page to the fresh
    /// launch token: `appUrl` embeds a per-process token that a restart voids.
    private func handleConnectionLoss() {
        guard connected || connecting else { return }
        connected = false
        connecting = false
        updateStatus("host went away — reconnecting…")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.connect()
        }
    }

    private func updateStatus(_ text: String) {
        DispatchQueue.main.async { self.statusMenuItem?.title = text }
    }

    // MARK: - Window

    private func toggleWindow() {
        if quickAsk.closedRecently { return }
        if Date().timeIntervalSince(lastToggleAt) < 0.35 {
            debugLog("toggle suppressed (debounce)")
            return
        }
        lastToggleAt = Date()
        if quickAsk.isShown { quickAsk.close() } else { quickAsk.present() }
        if !connected { connect() }
    }
}
