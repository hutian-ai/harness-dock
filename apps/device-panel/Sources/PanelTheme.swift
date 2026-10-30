import AppKit
import SwiftUI

enum PanelTheme {
    static var appName: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Harness Dock" }
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
        guard let url = Bundle.main.url(forResource: "HutianLogo", withExtension: "png") else { return nil }
        return transparentBrandImage(at: url)
    }()

    static func statusItemImage() -> NSImage? {
        guard let source = brandImage, let image = source.copy() as? NSImage else { return nil }
        let scale = 18 / max(image.size.width, image.size.height)
        image.size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        image.isTemplate = true
        image.accessibilityDescription = "Harness Dock 设备面板"
        return image
    }

    /// The existing App artwork has an opaque black canvas. Remove only that
    /// canvas for inline/template use, preserving its original green silhouette.
    static func transparentBrandImage(at url: URL) -> NSImage? {
        guard let source = NSImage(contentsOf: url),
              let bitmap = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let width = bitmap.width, height = bitmap.height
        guard let representation = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32),
              let pixels = representation.bitmapData,
              let context = CGContext(data: pixels, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
        context.draw(bitmap, in: CGRect(x: 0, y: 0, width: width, height: height))
        var intensities = [Int](repeating: 0, count: 256)
        for index in stride(from: 0, to: width * height * 4, by: 4) {
            intensities[Int(max(pixels[index], pixels[index + 1], pixels[index + 2]))] += 1
        }
        // Use the solid mark's dominant intensity instead of rare compression
        // highlights, so its interior keeps the original artwork's color.
        guard let peak = (9..<256).max(by: { intensities[$0] < intensities[$1] }), intensities[peak] > 0 else { return nil }
        var left = width, top = height, right = 0, bottom = 0
        for y in 0..<height {
            for x in 0..<width {
                let index = (y * width + x) * 4
                let intensity = max(pixels[index], pixels[index + 1], pixels[index + 2])
                // The source contains near-black compression noise around its
                // canvas; it must not become part of a tiny template glyph.
                if intensity <= 8 {
                    pixels[index] = 0; pixels[index + 1] = 0; pixels[index + 2] = 0
                    pixels[index + 3] = 0
                } else {
                    pixels[index + 3] = UInt8(min(255, Int(intensity) * 255 / peak))
                }
                if intensity > 8 {
                    left = min(left, x); top = min(top, y)
                    right = max(right, x); bottom = max(bottom, y)
                }
            }
        }
        guard let image = context.makeImage()?.cropping(to: CGRect(x: left, y: top,
            width: right - left + 1, height: bottom - top + 1)) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
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
