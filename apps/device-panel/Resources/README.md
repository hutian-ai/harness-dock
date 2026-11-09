# 界舟 · Harness Dock artwork

The approved mark is `design/brand/jiezhou.svg`: an emerald vessel, geometric
sails and a docking notch, sharing hutian's 45-degree visual language.

- `JiezhouMark.png`: transparent 1024px mark for inline product branding.
- `AppIcon.png`: 1024px artwork on a dark rounded tile for macOS `.icns` packaging.
- `TrayTemplate.png`: transparent monochrome mark with tighter framing for the
  macOS menu bar. macOS supplies its light/dark color from the alpha channel.
- `HutianLogo.png`: historical hutian reference, retained for the design family
  comparison only; not included in packaged application resources.

Regenerate all three product PNGs on macOS:

```sh
swift scripts/render-brand.swift design/brand/jiezhou.svg apps/device-panel/Resources
```

`scripts/panel-icon.ts` packages `AppIcon.png` into standard macOS icon sizes.
`apps/gpui-panel/build.rs` embeds the same artwork at standard Windows ICO sizes
into the Windows executable, including the taskbar and window-class icon.
Both client frontends use the same transparent mark and tray template; neither
removes a background at runtime. The SVG is also used by the documentation site.
