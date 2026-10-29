import AppKit
import Carbon.HIToolbox

/// The one action a registered system-wide hotkey performs. Carbon's handler is
/// a C function pointer, so the target lives in a global rather than a capture.
private var gHotKeyAction: (() -> Void)?
private var gHotKeyFires = 0

private func hotKeyEventHandler(_ call: EventHandlerCallRef?,
                                _ event: EventRef?,
                                _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    gHotKeyFires += 1
    debugLog("hotkey fire #\(gHotKeyFires)")
    gHotKeyAction?()
    return noErr
}

/// System-wide hotkey via Carbon's RegisterEventHotKey.
///
/// Carbon is used on purpose: `NSEvent.addGlobalMonitorForEvents` needs
/// Accessibility permission and cannot see keystrokes inside other apps
/// reliably, while a registered hotkey works with no permission prompt.
final class GlobalHotKey {

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    /// Register the summon shortcut.
    /// - Parameters:
    ///   - keyCode: virtual key (default ⌃⌥Q).
    ///   - modifiers: Carbon modifier mask.
    ///   - callback: invoked on the main thread when pressed.
    /// - Returns: true when both the handler and the hotkey registered.
    func register(keyCode: UInt32 = UInt32(kVK_ANSI_Q),
                  modifiers: UInt32 = UInt32(controlKey | optionKey),
                  callback: @escaping () -> Void) -> Bool {
        gHotKeyAction = callback

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(),
                                               hotKeyEventHandler,
                                               1,
                                               &eventType,
                                               nil,
                                               &handlerRef)
        guard handlerStatus == noErr else { return false }

        let hotKeyID = EventHotKeyID(signature: OSType(0x44534842), id: 1) // 'DSHB'
        let registerStatus = RegisterEventHotKey(keyCode,
                                                modifiers,
                                                hotKeyID,
                                                GetApplicationEventTarget(),
                                                0,
                                                &hotKeyRef)
        return registerStatus == noErr
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
