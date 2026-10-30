import AppKit
import SwiftUI

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var item: NSStatusItem!
    private let popover = NSPopover()
    private var model: PanelModel!
    private var pendingInvitation: URL?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = ProcessInfo.processInfo.arguments
        let configIndex = arguments.firstIndex(of: "--config")
        let configOverride = configIndex.flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        model = PanelModel(resources: Bundle.main.resourceURL!, configOverride: configOverride)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = PanelTheme.statusItemImage()
        if item.button?.image == nil { item.button?.title = "HD" }
        item.button?.toolTip = "Harness Dock"
        item.button?.target = self
        item.button?.action = #selector(toggle)
        popover.behavior = .semitransient
        popover.delegate = self
        popover.contentSize = NSSize(width: 400, height: 520)
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model,
            resize: { [weak self] height in self?.updatePanelHeight(height) },
            hide: { [weak self] in self?.popover.performClose(nil) }, quit: { NSApp.terminate(nil) }))
        // Reopening the app reveals the panel; closing it never stops the independently owned daemon.
        show()
        if let invitation = pendingInvitation {
            pendingInvitation = nil
            model.receiveInvitation(invitation.absoluteString)
        }
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, urls.count == 1, url.scheme == "harness-dock" else { return }
        if model == nil { pendingInvitation = url; return }
        model.receiveInvitation(url.absoluteString)
        show()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    @objc private func toggle() { if popover.isShown { popover.performClose(nil) } else { show() } }
    func popoverDidClose(_ notification: Notification) { model.visible = false }
    private func updatePanelHeight(_ height: CGFloat) {
        let size = NSSize(width: 400, height: min(520, max(240, height)))
        if abs(popover.contentSize.height - size.height) >= 1 { popover.contentSize = size }
    }
    private func show() {
        guard let button = item?.button else { return }
        model.visible = true
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
        Task { await model.refresh() }
    }
}

@main struct HarnessDockApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
