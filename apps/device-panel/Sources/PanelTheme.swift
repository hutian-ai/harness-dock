import AppKit
import SwiftUI

enum PanelTheme {
    static var appName: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "界舟 · Harness Dock" }
    static let accent = Color(nsColor: NSColor(name: NSColor.Name("HarnessDockAccent")) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 115 / 255, green: 182 / 255, blue: 160 / 255, alpha: 1)
            : NSColor(srgbRed: 47 / 255, green: 128 / 255, blue: 106 / 255, alpha: 1)
    })
    static let action = Color.primary
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let separator = Color(nsColor: .separatorColor)
    static let onPrimary = Color(nsColor: .textBackgroundColor)

    static let brandImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "JiezhouMark", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    static func statusItemImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "TrayTemplate", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        image.accessibilityDescription = "界舟 · Harness Dock 设备面板"
        return image
    }

}

struct PanelBrandMark: View {
    var body: some View {
        Group {
            if let image = PanelTheme.brandImage {
                Image(nsImage: image).resizable().scaledToFit()
            }
        }
        .accessibilityHidden(true)
    }
}

struct PanelPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 34)
            .foregroundStyle(isEnabled ? PanelTheme.onPrimary : .secondary)
            .background(isEnabled ? PanelTheme.action : Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct PanelRowButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(isEnabled ? 1 : 0.65)
            .background(Color.primary.opacity(isEnabled && (hovering || configuration.isPressed) ? (configuration.isPressed ? 0.075 : 0.035) : 0))
            .onHover { hovering = $0 }
    }
}

struct PanelIconButtonStyle: ButtonStyle {
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(.secondary)
            .background(Color.primary.opacity(configuration.isPressed ? 0.09 : hovering ? 0.05 : 0), in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle()).onHover { hovering = $0 }
    }
}

extension View {
    func panelSurface() -> some View {
        padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(PanelTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(PanelTheme.separator.opacity(0.5), lineWidth: 0.5))
    }
}
