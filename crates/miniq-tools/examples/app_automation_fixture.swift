// Local-only acceptance fixture. No mailbox, credentials, or network operations.
import Cocoa
import CoreGraphics

let arguments = CommandLine.arguments

func argument(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

if arguments.contains("--probe") {
    let point = CGEvent(source: nil)?.location ?? .zero
    // Event-delivery flags such as maskNonCoalesced are not keyboard state.
    let modifiers: CGEventFlags = [
        .maskAlphaShift, .maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn,
    ]
    let value: [String: Any] = [
        "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
        "cursorX": point.x,
        "cursorY": point.y,
        "modifierFlags": CGEventSource.flagsState(.combinedSessionState)
            .intersection(modifiers).rawValue,
    ]
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

// A real custom view: AppKit routes events normally. No event monitors, manual
// forwarding, AXPress, or writable AX text attributes stand in for process input.
final class EventSurface: NSView {
    var onChange: (() -> Void)?
    private var text = ""
    private var namedKey = ""
    private var shiftedKey = false
    private var clicks = 0
    private var clickPoint = NSPoint.zero
    private var scrollEvents = 0
    private var scrollDeltaX = 0.0
    private var scrollDeltaY = 0.0

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func isAccessibilityFocused() -> Bool { window?.firstResponder === self }

    var state: [String: Any] {
        ["eventText": text, "eventNamedKey": namedKey, "eventShiftKey": shiftedKey,
         "eventClicks": clicks,
         "eventClickX": clickPoint.x, "eventClickY": clickPoint.y,
         "eventScrollCount": scrollEvents, "eventScrollX": scrollDeltaX,
         "eventScrollY": scrollDeltaY]
    }

    private func changed() {
        needsDisplay = true
        onChange?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 123 {
            namedKey = "ArrowLeft"
            shiftedKey = event.modifierFlags.contains(.shift)
        } else {
            text += event.characters ?? ""
        }
        changed()
    }

    override func mouseDown(with event: NSEvent) {
        clicks += 1
        clickPoint = convert(event.locationInWindow, from: nil)
        changed()
    }

    override func scrollWheel(with event: NSEvent) {
        scrollEvents += 1
        scrollDeltaX += event.scrollingDeltaX
        scrollDeltaY += event.scrollingDeltaY
        changed()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemIndigo.withAlphaComponent(0.3).setFill()
        dirtyRect.fill()
        let label = "Custom event surface\nText: \(text)\nKey: \(namedKey)\nClicks: \(clicks)\nScroll: \(scrollDeltaY)"
        label.draw(at: NSPoint(x: 20, y: 20), withAttributes: [
            .font: NSFont.systemFont(ofSize: 18), .foregroundColor: NSColor.labelColor,
        ])
    }
}

final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let subject = NSTextField(string: "Original fixture subject")
    private let body = NSTextView()
    private let counter = NSTextField(labelWithString: "Counter: 0")
    private let attachment = NSTextField(labelWithString: "Attachment: none")
    private let eventSurface = EventSurface(frame: .zero)
    private var presses = 0
    private var selectedBasename = ""
    private var timer: Timer?
    private let foreground = arguments.contains("--foreground")
    private let statePath = argument("--state-file")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = foreground
            ? NSRect(x: 830, y: 180, width: 380, height: 220)
            : NSRect(x: 100, y: 180, width: 660, height: 480)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.title = foreground ? "miniQ Fixture Foreground" : "miniQ Fixture Target"
        window.isReleasedWhenClosed = false
        if foreground {
            let text = NSTextField(labelWithString: "Keep this fixture in front.\nBackground actions must not focus the target.")
            text.frame = NSRect(x: 20, y: 100, width: 340, height: 60)
            window.contentView?.addSubview(text)
        } else if arguments.contains("--events") {
            eventSurface.frame = NSRect(x: 20, y: 20, width: 620, height: 420)
            eventSurface.setAccessibilityElement(true)
            eventSurface.setAccessibilityRole(.group)
            eventSurface.setAccessibilityIdentifier("fixture-event-surface")
            eventSurface.setAccessibilityLabel("Custom event surface")
            eventSurface.onChange = { [weak self] in self?.writeState() }
            window.contentView?.addSubview(eventSurface)
            window.makeFirstResponder(eventSurface)
        } else {
            buildTarget()
        }
        window.makeKeyAndOrderFront(nil)
        // Initialize ordinary AppKit focus once during fixture setup. The test
        // then starts a separate foreground process before invoking automation.
        NSApp.activate(ignoringOtherApps: true)
        writeState()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.writeState()
        }
    }

    private func buildTarget() {
        subject.frame = NSRect(x: 20, y: 420, width: 620, height: 28)
        subject.setAccessibilityIdentifier("fixture-subject")
        subject.setAccessibilityLabel("Subject")
        window.contentView?.addSubview(subject)

        let scroll = NSScrollView(frame: NSRect(x: 20, y: 205, width: 620, height: 195))
        scroll.hasVerticalScroller = true
        body.frame = NSRect(x: 0, y: 0, width: 600, height: 195)
        body.isRichText = false
        body.string = "Original fixture body"
        body.setAccessibilityIdentifier("fixture-body")
        body.setAccessibilityLabel("Body")
        scroll.documentView = body
        window.contentView?.addSubview(scroll)

        let secret = NSSecureTextField(string: "miniq-fixture-secret-never-expose")
        secret.frame = NSRect(x: 20, y: 155, width: 290, height: 28)
        secret.setAccessibilityIdentifier("fixture-password")
        secret.setAccessibilityLabel("Password")
        window.contentView?.addSubview(secret)

        let increment = NSButton(title: "Increment counter", target: self, action: #selector(increment))
        increment.frame = NSRect(x: 320, y: 150, width: 180, height: 36)
        increment.setAccessibilityIdentifier("fixture-increment")
        window.contentView?.addSubview(increment)
        counter.frame = NSRect(x: 510, y: 155, width: 130, height: 24)
        counter.setAccessibilityIdentifier("fixture-counter")
        window.contentView?.addSubview(counter)

        let choose = NSButton(title: "Choose attachment", target: self, action: #selector(chooseAttachment))
        choose.frame = NSRect(x: 20, y: 95, width: 180, height: 36)
        choose.setAccessibilityIdentifier("fixture-attachment-button")
        window.contentView?.addSubview(choose)
        attachment.frame = NSRect(x: 210, y: 98, width: 430, height: 24)
        attachment.setAccessibilityIdentifier("fixture-attachment-label")
        window.contentView?.addSubview(attachment)
        let note = NSTextField(labelWithString: "Synthetic content only. This fixture cannot send mail.")
        note.frame = NSRect(x: 20, y: 35, width: 620, height: 24)
        window.contentView?.addSubview(note)
    }

    @objc private func increment() {
        presses += 1
        counter.stringValue = "Counter: \(presses)"
        writeState()
    }

    @objc private func chooseAttachment() {
        let panel = NSOpenPanel()
        panel.title = "miniQ Fixture Attachment Picker"
        panel.message = "Choose only the synthetic fixture attachment."
        panel.prompt = "Attach fixture"
        panel.directoryURL = URL(fileURLWithPath: statePath).deletingLastPathComponent()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, let url = panel.url else { return }
            self.selectedBasename = url.lastPathComponent
            self.attachment.stringValue = "Attachment: \(url.lastPathComponent)"
            self.writeState()
        }
    }

    private func writeState() {
        var state: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "windowId": window.windowNumber,
            "title": window.title,
            "subject": subject.stringValue,
            "body": body.string,
            "presses": presses,
            "attachment": selectedBasename,
            "keyWindowId": NSApp.keyWindow?.windowNumber ?? -1,
            "active": NSApp.isActive,
        ]
        state.merge(eventSurface.state) { _, updated in updated }
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
        } catch {
            fputs("Fixture state write failed: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

guard argument("--state-file") != nil else {
    fputs("Usage: fixture --state-file /temporary/state.json [--foreground | --events], or --probe\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Fixture()
app.delegate = delegate
app.run()
