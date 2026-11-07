import AppKit

// Render the approved straight-line SVG without a second copy of its geometry.
final class BrandSVG: NSObject, XMLParserDelegate {
    var paths = [CGPath]()
    var translation = CGPoint.zero
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        if name == "g", let transform = attributes["transform"] {
            precondition(transform == "translate(0 16)", "Review the SVG transform before rendering")
            translation = CGPoint(x: 0, y: 16)
        }
        guard name == "path", let data = attributes["d"] else { return }
        let tokens = data.replacingOccurrences(of: "([A-Za-z])", with: " $1 ", options: .regularExpression)
            .split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
        let path = CGMutablePath()
        var index = 0, point = CGPoint.zero
        func number() -> CGFloat {
            let value = CGFloat(Double(tokens[index])!)
            index += 1
            return value
        }
        while index < tokens.count {
            let command = tokens[index]; index += 1
            switch command {
            case "M": point = CGPoint(x: number(), y: number()); path.move(to: point)
            case "L": point = CGPoint(x: number(), y: number()); path.addLine(to: point)
            case "H": point.x = number(); path.addLine(to: point)
            case "V": point.y = number(); path.addLine(to: point)
            case "Z": path.closeSubpath()
            default: preconditionFailure("Unsupported brand path command: \(command)")
            }
        }
        var transform = CGAffineTransform(translationX: translation.x, y: translation.y)
        paths.append(path.copy(using: &transform)!)
    }
}

let args = CommandLine.arguments
precondition(args.count == 3, "Usage: swift scripts/render-brand.swift <master.svg> <output-directory>")
let artwork = BrandSVG()
let parser = XMLParser(contentsOf: URL(fileURLWithPath: args[1]))!
parser.delegate = artwork
precondition(parser.parse() && artwork.paths.count == 3, "Expected the approved three-path mark")
let destination = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for (name, size, tile, template) in [("JiezhouMark.png", 1024, false, false), ("AppIcon.png", 1024, true, false), ("TrayTemplate.png", 256, false, true)] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: CGFloat(size) / 512, y: -CGFloat(size) / 512)
    if tile {
        context.setFillColor(CGColor(srgbRed: 12 / 255, green: 16 / 255, blue: 14 / 255, alpha: 1))
        context.addPath(CGPath(roundedRect: CGRect(x: 24, y: 24, width: 464, height: 464), cornerWidth: 104, cornerHeight: 104, transform: nil))
        context.fillPath()
    }
    if template || name == "JiezhouMark.png" {
        // Inline and menu-bar artwork uses tight framing; the app tile keeps its inset.
        context.translateBy(x: -512 / 6, y: -512 / 6)
        context.scaleBy(x: 4 / 3, y: 4 / 3)
    }
    context.setFillColor(template ? CGColor(gray: 0, alpha: 1) : CGColor(srgbRed: 0, green: 200 / 255, blue: 155 / 255, alpha: 1))
    for path in artwork.paths { context.addPath(path); context.fillPath() }
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name))
}
